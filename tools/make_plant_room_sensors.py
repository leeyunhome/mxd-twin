# -*- coding: utf-8 -*-
"""plant_room(기계실 배관) 센서 좌표 — 임의 배치가 아니라 학습된 splat의 색상별 파이프
클러스터 중심좌표를 직접 샘플링해서 잡았다(scripts/render_plant_room.py 학습 결과 위에서 계산).
"""
import json
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "spaces", "plant_room.sensors.json")

SYSTEMS = {
    "HVAC": {
        "label": "공조", "unit": "°C", "color": "#3f8fd0",
        "protocol": "Modbus TCP", "verified": True,
        "note": "실무: Node-RED 통합관제에서 Modbus Holding Register 수집",
    },
    "POWER": {
        "label": "전력·에너지", "unit": "W", "color": "#6fae72",
        "protocol": "Modbus TCP", "verified": True,
        "note": "실무: Modbus 계측값 수집·대시보드 시각화",
    },
    "FIRE": {
        "label": "소방·누수", "unit": "", "color": "#c0392b",
        "protocol": "접점(DI)", "verified": True,
        "note": "실무: 화재감지 연동 통합관제 화면 개발",
    },
}

# 좌표 출처: point_cloud.ply를 opacity>0.5, 색상별 RGB 마스크로 필터링해 median 위치 계산
# (green/yellow/blue/orange 파이프, brown 제어박스) — office/classroom과 달리 실측 배관
# 색상 자체에서 좌표를 뽑은 것이라 임의 배치가 아님.
SENSORS = [
    ("HVAC", "공조 배관 표면 온도", "pipe/blue-supply", [0.214, 0.023, 0.357]),
    ("HVAC", "공조 배관 표면 온도", "pipe/orange-return", [0.627, 0.173, 0.562]),
    ("HVAC", "공조 배관 표면 온도", "pipe/green-branch", [0.952, 0.014, -0.121]),
    ("POWER", "제어반 전력", "control-box", [-0.053, -0.274, -0.186]),
    ("POWER", "배전 배관 부하", "pipe/yellow-conduit", [0.612, 0.009, 0.543]),
    ("FIRE", "연기 감지", "ceiling/smoke-A", [0.55, 0.6, 0.3]),
]


def main():
    counters = {}
    sensors = []
    for system, kind, anchor, pos in SENSORS:
        counters[system] = counters.get(system, 0) + 1
        sensors.append({
            "id": f"{system}-{counters[system]:02d}", "system": system, "kind": kind,
            "anchor": anchor, "position": [round(v, 3) for v in pos],
        })

    doc = {
        "coordinate_system": "3DGS splat 좌표 (Y-up, 정규화 단위). 색상별 파이프 클러스터의 median 위치.",
        "systems": SYSTEMS,
        "sensors": sensors,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f"wrote {OUT}: {len(sensors)} sensors / {len(SYSTEMS)} systems")


if __name__ == "__main__":
    main()
