import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh } from "@sparkjsdev/spark";
import { Simulation } from "./sim.js";

// 세 공간 모두 같은 파이프라인(카메라 포즈 설계 -> pyrender/Blender 렌더 -> 3DGS 학습,
// COLMAP 불필요)으로 만들었지만, 공간 성격이 달라 학습 커버리지·씬 좌표·앵커링 방식이
// 매번 달랐다(splatting-viewer 프로젝트 페이지에 그 경위를 정리해뒀다). 여기서는 그 결과물
// 3개를 하나의 관제 UI로 전환해가며 보여준다.
const SPACES = {
    office: {
        label: "오피스", key: "office",
        splatUrl: "data/modern_office_cleaned.ply",
        sensorsUrl: "data/spaces/office.sensors.json",
        invertY: false,
        roomCenter: [1.1, 0.1, -1.0],
        cameraOffset: [2.6, 1.5, 2.2],
        coverage: { elevMin: 8, elevMax: 65, distMin: 1.6, distMax: 7.0 },
        note: "CC-BY 공개 3D 모델(Sketchfab, dylanheyes)을 렌더해 학습. 반사 스트릭 제거를 위해 공간 경계로 크롭.",
    },
    classroom: {
        label: "교실", key: "classroom",
        splatUrl: "data/classroom.ply",
        sensorsUrl: "data/spaces/classroom.sensors.json",
        invertY: false,
        // building-twin은 이 splat을 Blender Z-up 그대로 두고 부모 그룹 전체를
        // rotation.x=-PI/2로 돌려 Y-up으로 맞춘다. mxd-twin은 센서 좌표는 데이터
        // 생성 시점에 미리 변환해뒀지만(blenderToThree) splat 자체는 그대로였어서
        // 천장/바닥이 뒤집힌 채로 보였다 — 여기서 splat에만 같은 회전을 건다.
        upAxisFixX: -Math.PI / 2,
        // building-twin의 Blender 좌표(-0.58,-0.676,1.549)를 blenderToThree 변환한 값과 동일.
        roomCenter: [-0.58, 1.549, 0.676],
        // splatting-viewer에서 검증한 "돌하우스" 각도(고도각 55°, 방위각 35°, 거리 16)를 그대로
        // 구면좌표로 계산. 이전 값(9,11,9)은 고도각이 약 41°로 커버리지 상한(45°) 밖이라
        // OrbitControls가 첫 update()에서 강제로 재투영해 화면이 비스듬히 틀어져 보였다.
        cameraOffset: [5.27, 13.1, 7.52],
        coverage: { elevMin: 45, elevMax: 85, distMin: 9, distMax: 34 },
        note: "CC0 공개 모델(Blender Classroom)을 렌더해 학습. building-twin과 같은 학습 결과물.",
    },
    plant_room: {
        label: "기계실", key: "plant_room",
        splatUrl: "data/plant_room.ply",
        sensorsUrl: "data/spaces/plant_room.sensors.json",
        invertY: false,
        // 학습 자체가 궤도 반지름 0.35 고정이라, 그보다 멀리서 보는 "넓은 조망"은
        // 애초에 학습 안 된 영역 — 실제로 더 큰 반지름으로 테스트해보니 재구성이
        // 무너져 빈 공간만 나왔다. 그래서 임의 각도를 새로 계산하는 대신, 실제
        // 학습 프레임(train/r_0031.png) 중 천장 배관 합류부·정션박스·바닥 배관까지
        // 한 화면에 가장 많이 들어오는 구도의 카메라 좌표를 그대로 가져왔다.
        roomCenter: [0, 0, 0],
        cameraOffset: [-0.299, -0.154, -0.097],
        coverage: { elevMin: -35, elevMax: 45, distMin: 0.15, distMax: 1.4 },
        // 다른 공간은 정규화 안 된 원본 스케일(반경 2~17)이라 마커 0.11이 작게 보이지만,
        // 이 공간은 학습 시 카메라 반지름 자체가 0.35라 같은 절대 크기가 상대적으로 커 보인다.
        markerScale: 0.35,
        note: "CC-BY 공개 모델(Sketchfab, geppettomaster)을 렌더해 학습. 밀폐된 방이라 궤도 반지름을 방 안쪽으로 줄여 촬영.",
    },
};
const SOP_URL = "data/spaces/shared.sop.json";

const state = {
    sensors: [], systems: {}, sop: {}, sim: null,
    markers: new Map(), filter: null, selected: null,
    autoRotate: false, space: null,
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

const content = new THREE.Group();
scene.add(content);

const markerGroup = new THREE.Group();
content.add(markerGroup);

let currentSplat = null;

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

function clearMarkers() {
    for (const sprite of state.markers.values()) markerGroup.remove(sprite);
    state.markers.clear();
}

function buildMarkers() {
    for (const s of state.sensors) {
        const color = state.systems[s.system]?.color || "#888";
        const mat = new THREE.SpriteMaterial({
            map: pinTexture(color, RING.ok), depthTest: false, transparent: true,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(...s.position);
        sprite.scale.setScalar(MARKER_SIZE * (SPACES[state.space].markerScale ?? 1));
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
        const scale = SPACES[state.space].markerScale ?? 1;
        sprite.scale.setScalar(MARKER_SIZE * scale * pulse * chosen);
    }
}

/* ---------------- 카메라 이동 ---------------- */

let flight = null;
function flyTo(targetWorld, keepDistance = true, fallbackDist = 3.4) {
    const from = camera.position.clone();
    const dir = from.clone().sub(controls.target).normalize();
    const dist = keepDistance ? from.distanceTo(controls.target) : fallbackDist;
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
    const start = Math.PI, end = 0;

    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2a3543";
    ctx.beginPath(); ctx.arc(cx, cy, r, start, end, true); ctx.stroke();

    const color = st.status === "alarm" ? "#d0503f" : st.status === "warn" ? "#d8a33a" : "#4aa08a";
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, start, start - frac * Math.PI, true); ctx.stroke();

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
    el("kpi-occ").textContent = occ ? `${Math.round(occ)}명` : "–";
    const power = states.filter((s) => s.system === "POWER").reduce((a, s) => a + s.value, 0);
    el("kpi-power").textContent = power ? `${(power / 1000).toFixed(2)}kW` : "–";

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

/* ---------------- 공간 전환 ---------------- */

let tickTimer = null;

function loadSplat(space) {
    if (currentSplat) {
        content.remove(currentSplat);
        currentSplat = null;
    }
    el("loading").style.display = "flex";
    el("loading").textContent = "공간 모델 로딩 중…";
    const splat = new SplatMesh({ url: space.splatUrl });
    splat.rotation.x = (space.invertY ? Math.PI : 0) + (space.upAxisFixX || 0);
    content.add(splat);
    currentSplat = splat;
    splat.addEventListener("load", () => { el("loading").style.display = "none"; });
    splat.addEventListener("error", () => {
        el("loading").textContent = "공간 모델을 불러오지 못했습니다 — 센서 레이어만 표시합니다.";
    });
    setTimeout(() => { el("loading").style.display = "none"; }, 20000);
}

async function loadSpace(key) {
    const space = SPACES[key];
    state.space = key;

    deselect();
    state.filter = null;
    clearMarkers();
    el("event-list").innerHTML = "";
    if (tickTimer) clearInterval(tickTimer);

    const data = await (await fetch(space.sensorsUrl)).json();
    state.sensors = data.sensors;
    state.systems = data.systems;
    state.sim = new Simulation(state.sensors, state.systems);

    buildMarkers();
    renderSystemList();

    const roomCenter = new THREE.Vector3(...space.roomCenter);
    controls.target.copy(roomCenter);
    camera.position.copy(roomCenter.clone().add(new THREE.Vector3(...space.cameraOffset)));
    controls.minPolarAngle = THREE.MathUtils.degToRad(90 - space.coverage.elevMax);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - space.coverage.elevMin);
    controls.minDistance = space.coverage.distMin;
    controls.maxDistance = space.coverage.distMax;
    controls.update();

    loadSplat(space);

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
    renderKpis(states);
    tickTimer = setInterval(() => {
        states = state.sim.tick();
        renderKpis(states);
        if (state.selected) renderDetail();
    }, 2000);

    for (const btn of document.querySelectorAll("#space-tabs button")) {
        btn.classList.toggle("active", btn.dataset.space === key);
    }
    el("space-note").textContent = space.note;
    el("coverage-note").textContent =
        `시점 범위는 학습 커버리지(고도각 ${space.coverage.elevMin}~${space.coverage.elevMax}°)로 제한됩니다.`;
}

el("btn-overview").addEventListener("click", () => {
    state.filter = null;
    [...el("system-list").children].forEach((c) => c.classList.remove("active", "dimmed"));
    deselect();
    const space = SPACES[state.space];
    const overviewDist = new THREE.Vector3(...space.cameraOffset).length();
    flyTo(new THREE.Vector3(...space.roomCenter), false, overviewDist);
});
el("btn-autorotate").addEventListener("click", (e) => {
    state.autoRotate = !state.autoRotate;
    e.currentTarget.classList.toggle("on", state.autoRotate);
});
el("detail-close").addEventListener("click", deselect);

for (const btn of document.querySelectorAll("#space-tabs button")) {
    btn.addEventListener("click", () => loadSpace(btn.dataset.space));
}

async function main() {
    const sopDoc = await (await fetch(SOP_URL)).json();
    state.sop = sopDoc.sop;

    resize();
    await loadSpace("office");

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
        const dt = clock.getDelta();
        stepFlight(dt);
        if (state.autoRotate && !flight) {
            const off = camera.position.clone().sub(controls.target);
            off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.16);
            camera.position.copy(controls.target.clone().add(off));
        }
        if (state.sim) refreshMarkers([...state.sim.states.values()]);
        controls.update();
        renderer.render(scene, camera);
    });
}

main();
