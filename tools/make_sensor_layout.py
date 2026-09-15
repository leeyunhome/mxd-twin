# -*- coding: utf-8 -*-
"""오피스 공간(3DGS 재구성)에 MXD 8대 계통 센서를 배치해 data/sensors.json을 만든다.

좌표 기준
---------
building-twin(교실)은 Blender 씬의 개별 오브젝트(ceilingLamp, radiateur ...) 월드좌표를
그대로 앵커로 썼다. 이 오피스 모델(Sketchfab "Minimalistic Modern Office")은 오브젝트가
아니라 **재질별로 병합된 메시**(Glass/Structure/Table/Chair/Plants/Lights/Carpet)라 같은
방식이 성립하지 않는다.

그래서 여기서는 **학습된 3DGS 포인트클라우드 자체의 좌표**를 기준으로 삼았다.
point_cloud_clean.ply를 축별로 투영해(아래 ROOM/FEATURE 값) 바닥·천장·유리 파사드·화분·
테이블의 실제 위치를 좌표로 읽어낸 뒤, 그 구조 위에 센서를 배치한다. 즉 임의 좌표가 아니라
"재구성된 공간에서 확인되는 구조물" 위에 얹는다.

좌표계: splat 좌표 그대로(Y-up, 단위는 정규화 단위이며 실측 미터가 아님).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "sensors.json")

# point_cloud_clean.ply 투영으로 확인한 공간 구조 (splat 좌표)
ROOM = {
    "floor_y": -0.47,
    "ceil_y": 0.90,
    "x": [0.25, 1.95],
    "z": [-2.40, 0.40],
}
FEATURE = {
    "plant_a": [0.45, -0.15, 0.05],
    "plant_b": [0.50, -0.15, -2.15],
    "table": [1.35, -0.25, -1.00],
    "facade_x": 1.90,
    "entry_x": 0.30,
}

CEIL = ROOM["ceil_y"] - 0.05
FLOOR = ROOM["floor_y"] + 0.01

# 공고가 요구한 통합 대상 계통에 맞춘 8계통.
# protocol.verified = 실무에서 직접 다뤄본 규격인지 여부 — 화면에 그대로 표기한다.
SYSTEMS = {
    "HVAC": {
        "label": "공조", "unit": "°C", "color": "#3f8fd0",
        "protocol": "Modbus TCP", "verified": True,
        "note": "실무: Node-RED 통합관제에서 Modbus Holding Register 수집",
    },
    "LIGHTING": {
        "label": "조명", "unit": "lx", "color": "#d8b23a",
        "protocol": "BACnet/IP", "verified": False,
        "note": "사양 설계 수준 — 어댑터 인터페이스만 정의",
    },
    "POWER": {
        "label": "전력·에너지", "unit": "W", "color": "#6fae72",
        "protocol": "Modbus TCP", "verified": True,
        "note": "실무: Modbus 계측값 수집·대시보드 시각화",
    },
    "OCCUPANCY": {
        "label": "재실", "unit": "명", "color": "#8e6fb8",
        "protocol": "MQTT", "verified": False,
        "note": "사양 설계 수준",
    },
    "SECURITY": {
        "label": "출입·보안", "unit": "", "color": "#c26fa0",
        "protocol": "RTSP + 접점(DI)", "verified": True,
        "note": "실무: RTSP 스트리밍 통합관제 화면 자체 개발",
    },
    "EV": {
        "label": "EV 충전", "unit": "kW", "color": "#4fa8a0",
        "protocol": "OCPP 1.6J", "verified": False,
        "note": "사양 설계 수준",
    },
    "SIGNAGE": {
        "label": "디지털 사이니지", "unit": "", "color": "#c98a4b",
        "protocol": "HTTP API", "verified": False,
        "note": "사양 설계 수준",
    },
    "FIRE": {
        "label": "소방·누수", "unit": "", "color": "#c0392b",
        "protocol": "접점(DI)", "verified": True,
        "note": "실무: 화재감지 연동 통합관제 화면 개발",
    },
}

SENSORS = [
    # 공조 — 천장 디퓨저 그리드
    ("HVAC", "급기 디퓨저 온도", "ceiling/diffuser-N1", [0.70, CEIL, -0.20]),
    ("HVAC", "급기 디퓨저 온도", "ceiling/diffuser-N2", [1.50, CEIL, -0.60]),
    ("HVAC", "환기 디퓨저 온도", "ceiling/diffuser-S1", [0.70, CEIL, -1.40]),
    ("HVAC", "환기 디퓨저 온도", "ceiling/diffuser-S2", [1.50, CEIL, -2.00]),
    # 조명 — 천장 조명 존
    ("LIGHTING", "조도 센서", "ceiling/light-zone-A", [0.55, CEIL, -0.50]),
    ("LIGHTING", "조도 센서", "ceiling/light-zone-B", [1.30, CEIL, -1.20]),
    ("LIGHTING", "조도 센서", "ceiling/light-zone-C", [0.60, CEIL, -1.90]),
    # 전력 — 분전반·층 계량
    ("POWER", "분전반 부하", "wall/panel-main", [ROOM["x"][0] + 0.10, -0.30, -1.20]),
    ("POWER", "존 계량", "wall/meter-east", [FEATURE["facade_x"] - 0.05, -0.30, -0.40]),
    # 재실
    ("OCCUPANCY", "재실 카운트", "ceiling/pir-A", [1.00, CEIL - 0.05, -0.80]),
    ("OCCUPANCY", "재실 카운트", "ceiling/pir-B", [1.00, CEIL - 0.05, -1.80]),
    # 출입·보안
    ("SECURITY", "출입문 상태", "entry/door-main", [FEATURE["entry_x"], 0.20, -0.10]),
    ("SECURITY", "출입문 상태", "entry/door-side", [FEATURE["entry_x"], 0.20, -2.30]),
    # EV 충전 — 파사드 외측 주차 구역
    ("EV", "충전기 출력", "parking/evse-01", [FEATURE["facade_x"], FLOOR, 0.25]),
    ("EV", "충전기 출력", "parking/evse-02", [FEATURE["facade_x"], FLOOR, -2.30]),
    # 사이니지
    ("SIGNAGE", "사이니지 상태", "wall/signage-lobby", [FEATURE["facade_x"], 0.30, -1.20]),
    # 소방·누수
    ("FIRE", "연기 감지", "ceiling/smoke-A", [0.90, CEIL + 0.03, -0.40]),
    ("FIRE", "연기 감지", "ceiling/smoke-B", [0.90, CEIL + 0.03, -1.60]),
    ("FIRE", "누수 감지", "floor/leak-plant-b", [FEATURE["plant_b"][0], FLOOR, FEATURE["plant_b"][2]]),
]


def main():
    counters = {}
    sensors = []
    for system, kind, anchor, pos in SENSORS:
        counters[system] = counters.get(system, 0) + 1
        sensors.append({
            "id": f"{system}-{counters[system]:02d}",
            "system": system,
            "kind": kind,
            "anchor": anchor,
            "position": [round(v, 3) for v in pos],
        })

    doc = {
        "coordinate_system": (
            "3DGS splat 좌표 (Y-up, 정규화 단위 — 실측 미터 아님). "
            "point_cloud_clean.ply 축별 투영으로 바닥/천장/파사드/가구 위치를 확인해 배치."
        ),
        "space": {"room": ROOM, "features": FEATURE},
        "systems": SYSTEMS,
        "sensors": sensors,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f"wrote {OUT}: {len(sensors)} sensors / {len(SYSTEMS)} systems")


if __name__ == "__main__":
    main()
