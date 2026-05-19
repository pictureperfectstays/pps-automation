# Daily Revenue Report — CoWork Routine

This file documents the scheduled CoWork routine for the daily revenue email.

## Schedule
Run daily at 7:00 AM Arizona time (14:00 UTC — AZ observes MST year-round, no DST).

## Routine Prompt

```
You are running the daily revenue report for Picture Perfect Stays.
Today's date: use the system date.

## Step 1 — Fetch PriceLabs prices for all 4 properties

Use the get_prices MCP tool to fetch prices for each property for the next 90 days.

Properties:
- listing_id: 471179 (Emerald Views)
- listing_id: 471178 (Enchanted Getaway)
- listing_id: 471181 (Musical Oasis)
- listing_id: 471180 (Travelers Paradise)

Date range: today through today+90 days (calculate dynamically).

## Step 2 — Write PriceLabs data to temp file

After fetching prices for all 4 properties, write a JSON file to C:\temp\pps-pl-prices.json (create the folder if needed).

The JSON format must be:
{
  "<listing_id>": {
    "<YYYY-MM-DD>": {
      "price": <number>,
      "user_price": <number or -1>,
      "demand_desc": "<string>",
      "min_stay": <number>,
      "unbookable": <0 or 1>,
      "booking_status": "<string>"
    }
  }
}

Only include dates where booking_status is "" (empty string = available/open).

Example:
{
  "471179": {
    "2026-06-01": { "price": 259, "user_price": 259, "demand_desc": "Normal Demand", "min_stay": 2, "unbookable": 0, "booking_status": "" }
  }
}

Use a Bash command to write the file (Windows path — use TEMP env var):
  node -e "require('fs').writeFileSync(require('os').tmpdir() + '/pps-pl-prices.json', JSON.stringify(<data>))"

## Step 3 — Run the report script

Run the following command (sets env var inline using node):
  node -e "process.env.PRICELABS_DATA_FILE = require('os').tmpdir() + '/pps-pl-prices.json'; import('C:/Users/crhan/Projects/PicturePerfectStays/daily-report/index.js')"

## Step 4 — Report result

Report whether the email was sent successfully and note any errors.
```

## Environment Variables Required in Routine

The routine needs these env vars available to the node script:
- `SUPABASE_URL` — auto-loaded from ~/.claude/settings.json
- `SUPABASE_SERVICE_KEY` — auto-loaded from ~/.claude/settings.json
- `RESEND_API_KEY` — must be added to ~/.claude/settings.json

## Setup Checklist

- [ ] Add `RESEND_API_KEY` to `~/.claude/settings.json`
- [ ] Verify `staypictureperfect.com` domain in Resend dashboard
- [ ] Add `reports@staypictureperfect.com` as a verified sender
- [ ] Create scheduled routine in CoWork with the prompt above
- [ ] Set schedule: `0 14 * * *` (14:00 UTC = 7:00 AM Arizona)
- [ ] Test by running manually once before activating schedule
