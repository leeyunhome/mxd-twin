import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh } from "@sparkjsdev/spark";
import { Simulation } from "./sim.js";

// 학습 원본(1,350,343 splats / 319MB)은 유리 파사드 바깥으로 반사 스트릭이 길게 뻗어
// 나갔고 로딩도 30~60초 걸렸다. 방 경계로 크롭해 272,624 splats / 64.5MB로 줄이면서
// 스트릭이 사라지고 GitHub 100MB 제한 안에 들어와 저장소에서 직접 서빙한다.
// 대신 유리 너머 배경(시클로라마)도 함께 잘려 창밖은 비어 보인다 — 방 안 관제가 목적이라 감수.
const SPLAT_URL = "data/modern_office_cleaned.ply";

// 학습 커버리지(고도각 8~65°, 카메라 반경 2.6)에서 유도한 시점 제약.
// 이 범위 밖은 학습 데이터가 없어 재구성이 무너지므로 뷰어에서 막는다.
const COVERAGE = { elevMin: 8, elevMax: 65, distMin: 1.6, distMax: 7.0 };

// 센서 좌표는 splat 좌표계(Y-up)로 직접 정의돼 있어 축 변환이 필요 없다.
const ROOM_CENTER = new THREE.Vector3(1.1, 0.1, -1.0);

const state = {
    sensors: [], systems: {}, sop: {}, sim: null,
    markers: new Map(), filter: null, selected: null,
    autoRotate: false,
};

const el = (id) => document.getElementById(id);

/* ---------------- 3D 무대 ---------------- */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
el("stage").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minPolarAngle = THREE.MathUtils.degToRad(90 - COVERAGE.elevMax);
controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - COVERAGE.elevMin);
controls.minDistance = COVERAGE.distMin;
controls.maxDistance = COVERAGE.distMax;

const content = new THREE.Group();
scene.add(content);

const markerGroup = new THREE.Group();
content.add(markerGroup);

function resize() {
    const { clientWidth: w, clientHeight: h } = el("stage");
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

/* ---------------- 마커 ---------------- */

const texCache = new Map();
function pinTexture(color, ring) {
    const key = `${color}|${ring}`;
    if (texCache.has(key)) return texCache.get(key);
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    g.lineWidth = 10; g.strokeStyle = ring; g.stroke();
    g.beginPath(); g.arc(64, 64, 15, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,.92)"; g.fill();
    const tex = new THREE.CanvasTexture(c);
    texCache.set(key, tex);
    return tex;
}

const RING = { ok: "rgba(255,255,255,.55)", warn: "#ffd479", alarm: "#ff6b57" };
const MARKER_SIZE = 0.11;

function buildMarkers() {
    for (const s of state.sensors) {
        const color = state.systems[s.system]?.color || "#888";
        const mat = new THREE.SpriteMaterial({
            map: pinTexture(color, RING.ok), depthTest: false, transparent: true,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(...s.position);
        sprite.scale.setScalar(MARKER_SIZE);
        sprite.renderOrder = 10;
        sprite.userData.id = s.id;
        markerGroup.add(sprite);
        state.markers.set(s.id, sprite);
    }
}

function refreshMarkers(states) {
    const t = performance.now() / 1000;
    for (const st of states) {
        const sprite = state.markers.get(st.id);
        if (!sprite) continue;
        sprite.visible = !state.filter || st.system === state.filter;
        const color = state.systems[st.system]?.color || "#888";
        sprite.material.map = pinTexture(color, RING[st.status]);
        const pulse = st.status === "alarm" ? 1 + Math.sin(t * 6) * 0.22
            : st.status === "warn" ? 1 + Math.sin(t * 3) * 0.1 : 1;
        const chosen = state.selected === st.id ? 1.45 : 1;
        sprite.scale.setScalar(MARKER_SIZE * pulse * chosen);
    }
}

/* ---------------- 카메라 이동 ---------------- */

let flight = null;
function flyTo(targetWorld, keepDistance = true) {
    const from = camera.position.clone();
    const dir = from.clone().sub(controls.target).normalize();
    const dist = keepDistance ? from.distanceTo(controls.target) : 3.4;
    flight = {
        t: 0,
        fromTarget: controls.target.clone(), toTarget: targetWorld.clone(),
        fromPos: from, toPos: targetWorld.clone().add(dir.multiplyScalar(dist)),
    };
}

function stepFlight(dt) {
    if (!flight) return;
    flight.t = Math.min(1, flight.t + dt * 1.6);
    const e = 1 - Math.pow(1 - flight.t, 3);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    if (flight.t >= 1) flight = null;
}

function worldOf(sensorId) {
    const sprite = state.markers.get(sensorId);
    return sprite ? sprite.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
}

/* ---------------- 선택 ---------------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(markerGroup.children.filter((m) => m.visible), false);
    if (hits.length) select(hits[0].object.userData.id, false);
    else deselect();
});

function select(id, fly = true) {
    state.selected = id;
    state.autoRotate = false;
    el("btn-autorotate").classList.remove("on");
    if (fly) flyTo(worldOf(id));
    renderDetail();
}

function deselect() {
    state.selected = null;
    el("detail").classList.add("hidden");
}

/* ---------------- UI ---------------- */

function renderSystemList() {
    const list = el("system-list");
    list.innerHTML = "";
    for (const [key, sys] of Object.entries(state.systems)) {
        const items = state.sensors.filter((s) => s.system === key);
        if (!items.length) continue;
        const li = document.createElement("li");
        li.style.color = sys.color;
        li.innerHTML = `<span class="dot" style="background:${sys.color}"></span>`
            + `<span class="sys-name">${sys.label}</span>`
            + `<span class="sys-proto ${sys.verified ? "real" : "spec"}">${sys.protocol}</span>`
            + `<span class="sys-bad" data-bad="${key}"></span>`;
        li.title = sys.note;
        li.addEventListener("click", () => {
            state.filter = state.filter === key ? null : key;
            [...list.children].forEach((c) => c.classList.remove("active", "dimmed"));
            if (state.filter) {
                li.classList.add("active");
                [...list.children].filter((c) => c !== li).forEach((c) => c.classList.add("dimmed"));
            }
        });
        list.appendChild(li);
    }
}

function renderDetail() {
    const st = state.sim.states.get(state.selected);
    if (!st) { el("detail").classList.add("hidden"); return; }
    const sys = state.systems[st.system];
    el("detail").classList.remove("hidden");
    el("detail-title").textContent = st.kind;
    el("detail-system").textContent = `${sys.label} · ${st.id}`;
    el("detail-value").textContent = state.sim.format(st);
    el("detail-value").style.color = st.status === "alarm" ? "#ff6b57"
        : st.status === "warn" ? "#ffd479" : "#d9e1ec";
    el("detail-meta").innerHTML =
        `<div><dt>상태</dt><dd>${{ ok: "정상", warn: "주의", alarm: "경보" }[st.status]}</dd></div>`
        + `<div><dt>수집 규격</dt><dd>${sys.protocol}`
        + `<span class="tag ${sys.verified ? "real" : "spec"}">${sys.verified ? "실무" : "사양"}</span></dd></div>`
        + `<div><dt>앵커</dt><dd>${st.anchor}</dd></div>`;
    renderTrend(st);
    renderSop(st);
}

// Node-RED 대시보드(Thermal Home/MDS Home)에서 쓰던 "게이지 + 분/시 추세" 패턴을
// 여기서는 SVG 라이브러리 없이 Canvas로 직접 그린다 — edge-monitor와 같은 방식.
function renderTrend(st) {
    const box = el("detail-trend");
    if (st.rule.discrete || !st.history || st.history.length < 2) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    drawGauge(st);
    drawSparkline(st);
}

function drawGauge(st) {
    const canvas = el("gaugeCanvas");
    const ctx = canvas.getContext("2d");
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h - 12, r = Math.min(w / 2 - 8, h - 24);
    const [lo, hi] = st.rule.range;
    const frac = Math.max(0, Math.min(1, (st.value - lo) / (hi - lo)));
    const start = Math.PI, end = 0; // 반원(왼쪽 180도 -> 오른쪽 0도)

    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2a3543";
    ctx.beginPath(); ctx.arc(cx, cy, r, start, end, true); ctx.stroke();

    const color = st.status === "alarm" ? "#d0503f" : st.status === "warn" ? "#d8a33a" : "#4aa08a";
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, start, start - frac * Math.PI, true); ctx.stroke();

    // 정상 범위 구간 표시(옅은 초록 눈금)
    if (st.rule.warn) {
        const [wlo, whi] = st.rule.warn;
        const f1 = Math.max(0, Math.min(1, (wlo - lo) / (hi - lo)));
        const f2 = Math.max(0, Math.min(1, (whi - lo) / (hi - lo)));
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(74,160,138,0.6)";
        ctx.beginPath(); ctx.arc(cx, cy, r + 8, start - f1 * Math.PI, start - f2 * Math.PI, true); ctx.stroke();
    }

    ctx.fillStyle = "#d9e1ec";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(state.sim.format(st), cx, cy - 4);
}

function drawSparkline(st) {
    const canvas = el("trendCanvas");
    const ctx = canvas.getContext("2d");
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const hist = st.history;
    const [lo, hi] = st.rule.range;
    const pad = 6;
    const step = (w - pad * 2) / Math.max(1, hist.length - 1);

    ctx.strokeStyle = "#2a3543";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    const color = st.status === "alarm" ? "#d0503f" : st.status === "warn" ? "#d8a33a" : "#8fd0ff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    hist.forEach((v, i) => {
        const x = pad + i * step;
        const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        const y = h - pad - f * (h - pad * 2);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#626a86";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("최근 5분", 4, 10);
}

function renderSop(st) {
    const sop = state.sop[st.system];
    const box = el("sop");
    if (!sop) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    el("sop-title").textContent = sop.title;
    el("sop-sev").textContent = sop.severity;
    el("sop-steps").innerHTML = sop.steps.map((s) => `<li>${s}</li>`).join("");
    el("sop-esc").textContent = sop.escalation;
    el("sop-rec").textContent = sop.records;
}

function renderKpis(states) {
    const count = (lv) => states.filter((s) => s.status === lv).length;
    el("kpi-ok").textContent = count("ok");
    el("kpi-warn").textContent = count("warn");
    el("kpi-alarm").textContent = count("alarm");
    const occ = states.filter((s) => s.system === "OCCUPANCY").reduce((a, s) => a + s.value, 0);
    el("kpi-occ").textContent = `${Math.round(occ)}명`;
    const power = states.filter((s) => s.system === "POWER").reduce((a, s) => a + s.value, 0);
    el("kpi-power").textContent = `${(power / 1000).toFixed(2)}kW`;

    for (const key of Object.keys(state.systems)) {
        const bad = states.filter((s) => s.system === key && s.status !== "ok").length;
        const node = document.querySelector(`[data-bad="${key}"]`);
        if (node) node.textContent = bad ? `●${bad}` : "";
    }
}

function pushEvent(level, text) {
    const list = el("event-list");
    const li = document.createElement("li");
    li.className = level;
    const d = new Date();
    const now = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((v) => String(v).padStart(2, "0")).join(":");
    const label = { ok: "복구", warn: "주의", alarm: "경보" }[level] || level;
    li.innerHTML = `<span class="t">${now}</span><span class="lv">${label}</span><span>${text}</span>`;
    list.prepend(li);
    while (list.children.length > 60) list.lastChild.remove();
}

/* ---------------- 기동 ---------------- */

function loadSplat() {
    const splat = new SplatMesh({ url: SPLAT_URL });
    content.add(splat);
    splat.addEventListener("load", () => { el("loading").style.display = "none"; });
    splat.addEventListener("error", () => {
        el("loading").textContent = "공간 모델을 불러오지 못했습니다 — 센서 레이어만 표시합니다.";
    });
    // load 이벤트가 늦어도 화면이 계속 '로딩 중'으로 남지 않게 보조 타이머를 둔다.
    setTimeout(() => { el("loading").style.display = "none"; }, 20000);
}

async function main() {
    const [data, sopDoc] = await Promise.all([
        (await fetch("data/sensors.json")).json(),
        (await fetch("data/sop.json")).json(),
    ]);
    state.sensors = data.sensors;
    state.systems = data.systems;
    state.sop = sopDoc.sop;
    state.sim = new Simulation(state.sensors, state.systems);

    buildMarkers();
    renderSystemList();

    controls.target.copy(ROOM_CENTER);
    camera.position.copy(ROOM_CENTER.clone().add(new THREE.Vector3(2.6, 1.5, 2.2)));
    resize();
    loadSplat();

    state.sim.onEvent((ev) => {
        const sys = state.systems[ev.sensor.system].label;
        if (ev.type === "restored") {
            pushEvent("ok", `${sys} · ${ev.sensor.kind} 정상 복구 (${ev.sensor.id})`);
            return;
        }
        pushEvent(ev.level, `${sys} · ${ev.sensor.kind} ${state.sim.format(ev.sensor)} (${ev.sensor.id})`);
        if (ev.level === "alarm") select(ev.sensor.id);
    });

    let states = state.sim.tick();
    setInterval(() => {
        states = state.sim.tick();
        renderKpis(states);
        if (state.selected) renderDetail();
    }, 2000);
    renderKpis(states);

    el("btn-overview").addEventListener("click", () => {
        state.filter = null;
        [...el("system-list").children].forEach((c) => c.classList.remove("active", "dimmed"));
        deselect();
        flyTo(ROOM_CENTER, false);
    });
    el("btn-autorotate").addEventListener("click", (e) => {
        state.autoRotate = !state.autoRotate;
        e.currentTarget.classList.toggle("on", state.autoRotate);
    });
    el("detail-close").addEventListener("click", deselect);

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
        const dt = clock.getDelta();
        stepFlight(dt);
        if (state.autoRotate && !flight) {
            const off = camera.position.clone().sub(controls.target);
            off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.16);
            camera.position.copy(controls.target.clone().add(off));
        }
        refreshMarkers([...state.sim.states.values()]);
        controls.update();
        renderer.render(scene, camera);
    });
}

main();
