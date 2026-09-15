// 센서 값 시뮬레이션.
// 실제 설비와 연동하지 않는 데모이므로 값은 여기서 생성한다(화면·README에 명시).
// 계통별 정상대역 안에서 완만한 랜덤워크를 돌리다가 주기적으로 하나를 이상상태로 밀어
// 넣어, "이상 발생 → 공간에서 위치 식별 → 대응 절차 확인"까지의 동선을 재현한다.

// range = 물리적으로 가능한 값의 범위. 이상 주입으로 값을 밀어도 range를 넘지 않게 잘라
// 경보 상태에서도 수치 자체는 현실적인 값으로 남긴다.
const RULES = {
    HVAC: { unit: "°C", base: 22.5, jitter: 0.18, range: [-5, 45], warn: [20, 26], alarm: [18, 28] },
    LIGHTING: { unit: "lx", base: 520, jitter: 14, range: [0, 1500], warn: [280, 800], alarm: [150, 950] },
    POWER: { unit: "W", base: 1450, jitter: 55, range: [0, 6000], warn: [0, 2600], alarm: [0, 3200] },
    OCCUPANCY: { unit: "명", base: 14, jitter: 0.8, range: [0, 60], warn: [0, 34], alarm: [0, 44] },
    EV: { unit: "kW", base: 7.2, jitter: 0.35, range: [0, 22], warn: [0, 11.5], alarm: [0, 14] },
    SECURITY: { discrete: ["시건", "통행", "강제개방"], weights: [0.95, 0.045, 0.005] },
    SIGNAGE: { discrete: ["정상", "재생지연", "오프라인"], weights: [0.96, 0.03, 0.01] },
    FIRE: { discrete: ["정상", "점검중", "감지"], weights: [0.98, 0.015, 0.005] },
};

const DISCRETE_STATUS = {
    "정상": "ok", "시건": "ok", "통행": "ok",
    "점검중": "warn", "재생지연": "warn",
    "강제개방": "alarm", "오프라인": "alarm", "감지": "alarm",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Simulation {
    constructor(sensors, systems) {
        this.systems = systems;
        this.listeners = [];
        this.anomaly = null;
        this.tickCount = 0;
        this.states = new Map();
        for (const s of sensors) {
            const rule = RULES[s.system] || {};
            this.states.set(s.id, {
                ...s,
                rule,
                value: rule.discrete ? rule.discrete[0] : rule.base,
                status: "ok",
                prevStatus: "ok",
            });
        }
    }

    onEvent(fn) { this.listeners.push(fn); }

    emit(ev) { this.listeners.forEach((fn) => fn(ev)); }

    statusOf(st) {
        const r = st.rule;
        if (r.discrete) return DISCRETE_STATUS[st.value] || "ok";
        if (r.alarm && (st.value < r.alarm[0] || st.value > r.alarm[1])) return "alarm";
        if (r.warn && (st.value < r.warn[0] || st.value > r.warn[1])) return "warn";
        return "ok";
    }

    tick() {
        this.tickCount += 1;
        this.maybeStartAnomaly();

        for (const st of this.states.values()) {
            const r = st.rule;
            if (r.discrete) {
                // 실제 감지기는 몇 초 만에 감지↔정상을 오가지 않는다. 비정상 상태가 되면
                // 몇 틱 유지시켜 관제 화면에서 상태가 깜빡이지 않게 한다.
                if (this.anomaly?.id === st.id) {
                    st.value = r.discrete[r.discrete.length - 1];
                    st.holdUntil = this.tickCount + 4;
                } else if ((st.holdUntil || 0) > this.tickCount) {
                    // 유지 구간
                } else if (st.value !== r.discrete[0]) {
                    st.value = r.discrete[0];
                } else {
                    const next = this.pickDiscrete(r);
                    if (next !== r.discrete[0]) {
                        st.value = next;
                        st.holdUntil = this.tickCount + 3 + Math.floor(Math.random() * 4);
                    }
                }
            } else {
                const pull = (r.base - st.value) * 0.04;
                const noise = (Math.random() - 0.5) * 2 * r.jitter;
                let next = st.value + pull + noise;
                if (this.anomaly?.id === st.id) next += this.anomaly.dir * r.jitter * 6;
                st.value = clamp(next, r.range[0], r.range[1]);
            }

            st.prevStatus = st.status;
            st.status = this.statusOf(st);
            if (st.status !== st.prevStatus && st.status !== "ok") {
                this.emit({ type: "status", sensor: st, level: st.status });
            } else if (st.status === "ok" && st.prevStatus !== "ok") {
                this.emit({ type: "restored", sensor: st, level: "ok" });
            }
        }
        return [...this.states.values()];
    }

    pickDiscrete(r) {
        const x = Math.random();
        let acc = 0;
        for (let i = 0; i < r.discrete.length; i += 1) {
            acc += r.weights[i];
            if (x <= acc) return r.discrete[i];
        }
        return r.discrete[0];
    }

    maybeStartAnomaly() {
        if (this.anomaly && this.tickCount < this.anomaly.until) return;
        if (this.anomaly) { this.anomaly = null; return; }
        if (Math.random() > 0.16) return;
        const ids = [...this.states.keys()];
        const id = ids[Math.floor(Math.random() * ids.length)];
        this.anomaly = {
            id,
            until: this.tickCount + 6 + Math.floor(Math.random() * 6),
            dir: Math.random() < 0.5 ? -1 : 1,
        };
    }

    format(st) {
        if (st.rule.discrete) return st.value;
        const digits = st.rule.unit === "°C" ? 1 : st.rule.unit === "kW" ? 1 : 0;
        return `${st.value.toFixed(digits)}${st.rule.unit}`;
    }
}
