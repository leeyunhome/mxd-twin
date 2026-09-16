# -*- coding: utf-8 -*-
"""building-twin의 sensors.json(Blender Z-up)을 mxd-twin의 splat 좌표계(Y-up)로 변환.
building-twin의 app.js가 런타임에 매번 적용하던 blenderToThree(x,y,z)->(x,z,-y) 변환을
여기서는 데이터 생성 시점에 한 번만 적용해, mxd-twin 쪽 코드에 공간별 변환 분기를 안 둔다.
"""
import json
import os

SRC = r"C:/coding/my-github-repository/building-twin/data/sensors.json"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "spaces", "classroom.sensors.json")

# mxd-twin 스키마(office)에 맞춰 protocol/verified/note 부여.
# 근거: HVAC/POWER/SECURITY/FIRE는 오피스와 동일하게 실무(Node-RED Modbus·RTSP·접점) 근거 재사용.
# HEATING은 같은 Modbus 프로토콜의 다른 엔드포인트라 실무로 분류. LIGHTING/SHADING/OCCUPANCY는 사양.
SYSTEM_META = {
    "HVAC": {"protocol": "Modbus TCP", "verified": True, "note": "실무: Node-RED 통합관제에서 Modbus Holding Register 수집"},
    "HEATING": {"protocol": "Modbus TCP", "verified": True, "note": "실무: 같은 Modbus 계통의 밸브 액추에이터 엔드포인트"},
    "LIGHTING": {"protocol": "BACnet/IP", "verified": False, "note": "사양 설계 수준 — 어댑터 인터페이스만 정의"},
    "SHADING": {"protocol": "BACnet/IP", "verified": False, "note": "사양 설계 수준 — 어댑터 인터페이스만 정의"},
    "FIRE": {"protocol": "접점(DI)", "verified": True, "note": "실무: 화재감지 연동 통합관제 화면 개발"},
    "SECURITY": {"protocol": "RTSP + 접점(DI)", "verified": True, "note": "실무: RTSP 스트리밍 통합관제 화면 자체 개발"},
    "POWER": {"protocol": "Modbus TCP", "verified": True, "note": "실무: Modbus 계측값 수집·대시보드 시각화"},
    "OCCUPANCY": {"protocol": "MQTT", "verified": False, "note": "사양 설계 수준"},
}


def blender_to_three(p):
    return [p[0], p[2], -p[1]]


def main():
    with open(SRC, encoding="utf-8") as f:
        src = json.load(f)

    systems = {}
    for key, sys_ in src["systems"].items():
        meta = SYSTEM_META[key]
        systems[key] = {
            "label": sys_["label"], "unit": sys_["unit"], "color": sys_["color"],
            "protocol": meta["protocol"], "verified": meta["verified"], "note": meta["note"],
        }

    sensors = []
    for s in src["sensors"]:
        sensors.append({
            "id": s["id"], "system": s["system"], "kind": s["kind"], "anchor": s["anchor"],
            "position": [round(v, 3) for v in blender_to_three(s["position"])],
        })

    doc = {
        "coordinate_system": "3DGS splat 좌표 (Y-up) — building-twin의 Blender Z-up 좌표를 blenderToThree 변환으로 사전 변환.",
        "systems": systems,
        "sensors": sensors,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f"wrote {OUT}: {len(sensors)} sensors / {len(systems)} systems")


if __name__ == "__main__":
    main()
