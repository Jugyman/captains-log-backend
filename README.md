# Captain's Log Backend API

Discord-connected backend ingestion API for the Captain's Log maritime fleet game.

## What this does

- Accepts daily JSON reports from Raspberry Pi Captain's Log stations
- Checks an upload API key
- Prevents duplicate station/date reports
- Calculates MVP XP
- Tracks fleet all-time XP
- Enforces bottom-3 fleet joining during station registration
- Posts a Discord webhook summary
- Stores data in local JSON files for easy early testing

## Install

```bash
cd captains-log-backend
npm install
cp .env.example .env
```

Edit `.env`:

```bash
CAPTAINS_LOG_API_KEY=make_a_private_upload_key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook
POST_TO_DISCORD=true
```

## Run

```bash
npm start
```

Health check:

```bash
curl http://localhost:8787/health
```

## Register a station

```bash
curl -X POST http://localhost:8787/stations/register \
  -H "content-type: application/json" \
  -H "x-captains-log-key: make_a_private_upload_key" \
  -d '{
    "stationId": "pi1-wales",
    "stationName": "Pi1 Wales",
    "captainDiscordId": "1234567890",
    "fleet": "Atlantic Fleet"
  }'
```

## Upload a Captain's Log report

```bash
curl -X POST http://localhost:8787/reports/upload \
  -H "content-type: application/json" \
  -H "x-captains-log-key: make_a_private_upload_key" \
  -d @example-report.json
```

Or upload a wrapped payload:

```json
{
  "apiKey": "make_a_private_upload_key",
  "stationId": "pi1-wales",
  "captainDiscordId": "1234567890",
  "fleet": "Atlantic Fleet",
  "report": {
    "station": "Pi1 Wales",
    "date": "2026-05-17",
    "source": "docker:type5-only",
    "completedType5Messages": 218,
    "uniqueType5Ships": 16,
    "ships": [],
    "points": 1818
  }
}
```

## Leaderboards

```bash
curl http://localhost:8787/fleets
curl http://localhost:8787/leaderboard/all-time
curl http://localhost:8787/leaderboard/daily/2026-05-17
```

## API endpoints

### GET `/health`

Returns service health.

### GET `/fleets`

Returns fleet XP and current bottom three fleets.

### POST `/stations/register`

Registers or updates a station. New stations can only join a valid fleet under the balancing rules.

### POST `/reports/upload`

Uploads one station's daily Captain's Log JSON report.

### GET `/leaderboard/daily/:date`

Daily station and fleet leaderboard.

### GET `/leaderboard/all-time`

All-time station and fleet leaderboard.
