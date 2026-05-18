#!/usr/bin/env python3
"""
Captain's Log MVP
- Reads MastChain AIS logs from Docker or MastRadar/systemd journal
- Focuses on AIS Type 5 identity packets for clean game scoring
- Joins two-part Type 5 messages
- Decodes MMSI, IMO, callsign, ship name, ship type, dimensions, draught, ETA, destination
- Creates a JSON report

Examples:
  python3 captains_log.py --source docker --container mastchain-ais --tail 5000 --station "Pi1 Wales"
  python3 captains_log.py --source journal --service mastradar.service --since "24 hours ago" --station "Pi6"
"""

import argparse
import json
import re
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

AIS_CHARS = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?"

SHIP_TYPES = {
    0: "Not available",
    10: "Reserved / VTS / special craft",
    20: "Wing in ground",
    30: "Fishing",
    31: "Towing",
    32: "Towing large",
    33: "Dredging or underwater operations",
    34: "Diving operations",
    35: "Military operations",
    36: "Sailing",
    37: "Pleasure craft",
    40: "High speed craft",
    50: "Pilot vessel",
    51: "Search and rescue vessel",
    52: "Tug",
    53: "Port tender",
    54: "Anti-pollution equipment",
    55: "Law enforcement",
    58: "Medical transport",
    60: "Passenger",
    70: "Cargo",
    80: "Tanker",
    90: "Other type",
}

MMSI_MID_COUNTRIES = {
    "209": "Cyprus", "211": "Germany", "215": "Malta", "219": "Denmark",
    "224": "Spain", "226": "France", "229": "Malta", "232": "United Kingdom",
    "233": "United Kingdom", "234": "United Kingdom", "235": "United Kingdom",
    "236": "Gibraltar", "237": "Greece", "244": "Netherlands", "249": "Malta",
    "250": "Ireland", "257": "Norway", "316": "Canada", "338": "United States",
    "366": "United States", "367": "United States", "368": "United States", "369": "United States",
    "412": "China", "413": "China", "431": "Japan", "440": "South Korea",
    "477": "Hong Kong", "503": "Australia", "512": "New Zealand", "538": "Marshall Islands",
    "563": "Singapore", "636": "Liberia", "710": "Brazil",
}


def run_command(cmd: List[str]) -> List[str]:
    result = subprocess.run(cmd, capture_output=True, text=True)
    return (result.stdout + "\n" + result.stderr).splitlines()


def read_docker_logs(container: str, tail: str) -> List[str]:
    return run_command(["docker", "logs", "--tail", str(tail), container])


def read_journal_logs(service: str, since: str) -> List[str]:
    return run_command(["journalctl", "-u", service, "--since", since, "--no-pager"])


def sixbit_payload_to_bits(payload: str) -> str:
    bits = ""
    for ch in payload:
        val = ord(ch) - 48
        if val > 40:
            val -= 8
        bits += format(val, "06b")
    return bits


def bits_to_int(bits: str) -> int:
    return int(bits, 2) if bits else 0


def bits_to_text(bits: str) -> str:
    out = ""
    for i in range(0, len(bits), 6):
        chunk = bits[i:i + 6]
        if len(chunk) < 6:
            continue
        idx = int(chunk, 2)
        out += AIS_CHARS[idx] if idx < len(AIS_CHARS) else " "
    return out.replace("@", " ").strip()


def clean_text(value: str) -> str:
    return " ".join((value or "").replace("@", " ").split()).strip()


def decode_type5(payload: str) -> Dict:
    bits = sixbit_payload_to_bits(payload)

    if len(bits) < 424:
        # Type 5 is usually 424 bits after fill handling. We still try what exists.
        bits = bits.ljust(424, "0")

    dim_to_bow = bits_to_int(bits[240:249])
    dim_to_stern = bits_to_int(bits[249:258])
    dim_to_port = bits_to_int(bits[258:264])
    dim_to_starboard = bits_to_int(bits[264:270])

    eta_month = bits_to_int(bits[274:278])
    eta_day = bits_to_int(bits[278:283])
    eta_hour = bits_to_int(bits[283:288])
    eta_minute = bits_to_int(bits[288:294])

    draught_raw = bits_to_int(bits[294:302])
    draught_m = round(draught_raw / 10, 1) if draught_raw else None

    destination = clean_text(bits_to_text(bits[302:422]))

    eta = None
    if eta_month and eta_day and eta_hour < 24 and eta_minute < 60:
        eta = f"{eta_month:02d}-{eta_day:02d} {eta_hour:02d}:{eta_minute:02d}"

    ship_type = bits_to_int(bits[232:240])
    mmsi_decoded = bits_to_int(bits[8:38])
    mid = str(mmsi_decoded)[:3] if mmsi_decoded else ""

    return {
        "aisMsgType": bits_to_int(bits[0:6]),
        "mmsiDecoded": mmsi_decoded,
        "imo": bits_to_int(bits[40:70]),
        "callsign": clean_text(bits_to_text(bits[70:112])),
        "name": clean_text(bits_to_text(bits[112:232])),
        "shipType": ship_type,
        "shipTypeLabel": SHIP_TYPES.get((ship_type // 10) * 10, SHIP_TYPES.get(ship_type, "Unknown")),
        "lengthM": dim_to_bow + dim_to_stern if (dim_to_bow + dim_to_stern) else None,
        "widthM": dim_to_port + dim_to_starboard if (dim_to_port + dim_to_starboard) else None,
        "draughtM": draught_m,
        "destination": destination or None,
        "eta": eta,
        "flagMid": mid,
        "flagCountry": MMSI_MID_COUNTRIES.get(mid, "Unknown"),
    }


def parse_aivdm_type5_line(line: str) -> Optional[Dict]:
    if "MSG: 5" not in line or "!AIVDM" not in line:
        return None

    start = line.find("!AIVDM")
    aivdm_part = line[start:]
    fields = aivdm_part.split(",")

    if len(fields) < 7:
        return None

    try:
        total = int(fields[1])
        number = int(fields[2])
        seq = fields[3]
        channel = fields[4]
        payload = fields[5]
    except Exception:
        return None

    mmsi = re.search(r"MMSI:\s*(\d+)", line)
    signal = re.search(r"signalpower:\s*(-?\d+\.?\d*)", line)
    ppm = re.search(r"ppm:\s*(-?\d+\.?\d*)", line)
    ts = re.search(r"timestamp:\s*(\d+)", line)

    return {
        "total": total,
        "number": number,
        "seq": seq,
        "channel": channel,
        "payload": payload,
        "mmsi": mmsi.group(1) if mmsi else "UNKNOWN",
        "signalpower": float(signal.group(1)) if signal else None,
        "ppm": float(ppm.group(1)) if ppm else None,
        "timestamp": ts.group(1) if ts else None,
        "raw": line,
    }


def combine_type5(lines: List[str]) -> Tuple[List[Dict], int]:
    pending: Dict[Tuple, Dict[int, Dict]] = {}
    completed: List[Dict] = []
    fragments_seen = 0

    for line in lines:
        item = parse_aivdm_type5_line(line)
        if not item:
            continue

        fragments_seen += 1

        if item["total"] == 1:
            item["combinedPayload"] = item["payload"]
            item["decoded"] = decode_type5(item["combinedPayload"])
            completed.append(item)
            continue

        key = (item["seq"], item["channel"], item["mmsi"], item["timestamp"])
        pending.setdefault(key, {})[item["number"]] = item

        if len(pending[key]) == item["total"]:
            ordered = [pending[key][i] for i in range(1, item["total"] + 1)]
            first = ordered[0]
            first["combinedPayload"] = "".join(part["payload"] for part in ordered)
            first["decoded"] = decode_type5(first["combinedPayload"])
            completed.append(first)

    return completed, fragments_seen


def build_report(lines: List[str], station: str, source_label: str, captain_discord_id: str = "", station_id: str = "", fleet: str = "") -> Dict:
    completed, fragments_seen = combine_type5(lines)
    unique: Dict[str, Dict] = {}

    for item in completed:
        unique[item["mmsi"]] = item

    signals = [x["signalpower"] for x in completed if x.get("signalpower") is not None]

    ships = []
    for mmsi, item in sorted(unique.items()):
        decoded = item.get("decoded", {})
        ships.append({
            "mmsi": mmsi,
            "decodedMmsi": decoded.get("mmsiDecoded"),
            "name": decoded.get("name"),
            "callsign": decoded.get("callsign"),
            "imo": decoded.get("imo"),
            "shipType": decoded.get("shipType"),
            "shipTypeLabel": decoded.get("shipTypeLabel"),
            "flagMid": decoded.get("flagMid"),
            "flagCountry": decoded.get("flagCountry"),
            "lengthM": decoded.get("lengthM"),
            "widthM": decoded.get("widthM"),
            "draughtM": decoded.get("draughtM"),
            "destination": decoded.get("destination"),
            "eta": decoded.get("eta"),
            "signalpower": item.get("signalpower"),
            "ppm": item.get("ppm"),
            "timestamp": item.get("timestamp"),
        })

    # Basic local MVP points. Backend can recalculate final scoring globally.
    points = len(ships) * 100 + len(completed)

    return {
        "station": station,
        "stationId": station_id,
        "captainDiscordId": captain_discord_id,
        "fleet": fleet,
        "date": datetime.now(timezone.utc).date().isoformat(),
        "source": source_label,
        "type5FragmentsSeen": fragments_seen,
        "completedType5Messages": len(completed),
        "uniqueType5Ships": len(ships),
        "strongestSignal": max(signals) if signals else None,
        "weakestSignal": min(signals) if signals else None,
        "ships": ships,
        "points": points,
    }


def print_discord_summary(report: Dict) -> None:
    top_names = [s.get("name") for s in report.get("ships", []) if s.get("name")][:8]
    print("\n--- Discord Summary Preview ---")
    print(f"📘 Captain’s Log — {report['station']}")
    print(f"🚢 Named ships: {report['uniqueType5Ships']}")
    print(f"🏆 Local XP: {report['points']}")
    print(f"📡 Strongest signal: {report['strongestSignal']}")
    if top_names:
        print("\nTop catches:")
        for name in top_names:
            print(f"- {name}")


def upload_report(report: Dict, upload_url: str, api_key: str) -> Dict:
    payload = json.dumps({
        "apiKey": api_key,
        "stationId": report.get("stationId", ""),
        "captainDiscordId": report.get("captainDiscordId", ""),
        "fleet": report.get("fleet", ""),
        "report": report,
    }).encode("utf-8")

    req = urllib.request.Request(
        upload_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            try:
                return json.loads(body)
            except Exception:
                return {"ok": resp.status < 400, "status": resp.status, "body": body}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": e.code, "error": body}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Captain's Log AIS game report generator")
    parser.add_argument("--source", choices=["docker", "journal"], default="docker")
    parser.add_argument("--container", default="mastchain-ais")
    parser.add_argument("--tail", default="5000")
    parser.add_argument("--service", default="mastradar.service")
    parser.add_argument("--since", default="24 hours ago")
    parser.add_argument("--station", default="Test Station")
    parser.add_argument("--station-id", default="")
    parser.add_argument("--captain-discord-id", default="")
    parser.add_argument("--fleet", default="")
    parser.add_argument("--summary", action="store_true", help="Print Discord-style summary preview")
    parser.add_argument("--upload", action="store_true", help="Upload report to Captain\'s Log backend")
    parser.add_argument("--upload-url", default="", help="Captain\'s Log upload endpoint")
    parser.add_argument("--api-key", default="", help="Captain\'s Log API key")
    args = parser.parse_args()

    if args.source == "docker":
        lines = read_docker_logs(args.container, args.tail)
        source_label = "docker:type5-only"
    else:
        lines = read_journal_logs(args.service, args.since)
        source_label = "journal:type5-only"

    report = build_report(
        lines=lines,
        station=args.station,
        source_label=source_label,
        captain_discord_id=args.captain_discord_id,
        station_id=args.station_id,
        fleet=args.fleet,
    )

    filename = f"captains_log_{report['date']}.json"
    with open(filename, "w") as f:
        json.dump(report, f, indent=2)

    print(json.dumps(report, indent=2))
    print(f"\nSaved: {filename}")

    if args.summary:
        print_discord_summary(report)

    if args.upload:
        if not args.upload_url or not args.api_key:
            raise SystemExit("--upload requires --upload-url and --api-key")
        result = upload_report(report, args.upload_url, args.api_key)
        print("\n--- Upload Result ---")
        print(json.dumps(result, indent=2))
        if not result.get("ok"):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
