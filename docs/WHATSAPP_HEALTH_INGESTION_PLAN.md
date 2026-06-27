# WhatsApp Health Ingestion Plan

## Goal

Let non-technical family members submit BP, pulse, and sugar readings through WhatsApp without installing a new app or learning a new workflow.

The integration should support Family OS health tracking by turning WhatsApp image messages into structured readings that can be saved to the Family OS backend.

## Recommended User Experience

Create a dedicated WhatsApp bot contact:

```text
Family Health Bot
```

Family members use it like any normal WhatsApp chat:

1. Take a photo of the BP monitor or sugar meter.
2. Send the photo directly to `Family Health Bot`.
3. The bot reads the image and replies with a confirmation.

Example reply:

```text
Read this as:
BP: 126/93
Pulse: 85
Sugar: 157 mg/dL

Saved for Dad.
```

If someone already posts the photo in the existing family WhatsApp group, they can forward that image to `Family Health Bot`.

## Why Not Read The Existing Group Directly

Official WhatsApp Business APIs are designed around messages sent to a business number. They do not cleanly support joining and silently reading a normal personal WhatsApp group as a bot participant.

Avoid unofficial WhatsApp Web automation for this feature. It is fragile, can break unexpectedly, may conflict with WhatsApp terms, and is a poor fit for health-related data.

## Recommended Architecture

```text
Family member sends or forwards image
        |
        v
WhatsApp Business Cloud API webhook
        |
        v
Raspberry Pi HTTPS endpoint
        |
        v
Download media from WhatsApp
        |
        v
Send image to OpenAI vision model
        |
        v
Parse BP, pulse, and sugar as structured JSON
        |
        v
Save reading to Family OS backend
        |
        v
Reply to WhatsApp with extracted values
```

## WhatsApp Connectivity Options

### Option 1: Meta WhatsApp Cloud API

Use this as the preferred long-term path.

Pros:

- Lowest messaging cost.
- Direct integration with WhatsApp Business Platform.
- Good fit for self-hosting the webhook on Raspberry Pi.

Cons:

- More setup than Twilio.
- Requires Meta developer setup, WhatsApp Business configuration, webhook verification, and media download handling.

Expected WhatsApp cost for this family use case:

- If a family member sends the first message and the bot replies within the 24-hour customer service window, Meta service replies are generally not charged.
- Business-initiated template messages may cost money depending on country and category.

### Option 2: Twilio WhatsApp

Use this for fastest setup or prototyping.

Pros:

- Easier developer experience.
- Simpler webhook and media handling.
- Useful if Meta Cloud API setup becomes slow or annoying.

Cons:

- Adds Twilio markup.
- Current Twilio WhatsApp messaging price is about `$0.005` inbound and `$0.005` outbound, plus any Meta template fees when applicable.

Expected WhatsApp cost for this family use case:

- One photo sent by family plus one bot reply is about `$0.01`.
- 100 readings/month is about `$1/month`, excluding OpenAI model cost.

## Hosting

The Raspberry Pi can host the webhook and parser service.

The webhook must be reachable from the public internet over HTTPS.

Recommended options:

- Cloudflare Tunnel if a domain is available.
- ngrok for quick testing.
- Direct router port-forwarding only if HTTPS, firewalling, and updates are handled carefully.

## OpenAI Model Choice

Use:

- `gpt-5.4-mini` for normal parsing.
- `gpt-5.5` as a fallback when the image is blurry, angled, cropped, or confidence is low.

The model should return JSON only.

Example target output:

```json
{
  "bp_systolic": 126,
  "bp_diastolic": 93,
  "pulse": 85,
  "sugar_mg_dl": 157,
  "confidence": "high",
  "needs_review": false
}
```

## Confirmation And Correction Flow

The bot should reply with extracted values and keep the correction path simple.

High-confidence example:

```text
Saved:
BP 126/93
Pulse 85
Sugar 157 mg/dL
```

Low-confidence example:

```text
I read:
BP 126/93
Pulse 85
Sugar 157 mg/dL

Reply OK to save, or send the correct values.
```

Correction examples the bot should understand:

```text
OK
```

```text
Sugar is 151
```

```text
BP 128/91 pulse 84 sugar 157
```

## Data Handling

Prefer saving structured readings over retaining raw images.

Recommended policy:

- Save extracted reading values.
- Save sender, timestamp, and target family member.
- Keep raw images only temporarily for parsing and review.
- Delete raw images after successful extraction unless audit/review is explicitly required.
- Get family consent before turning on automated health-data ingestion.

## Open Questions

- Should readings default to one person, or should the bot ask who the reading belongs to?
- Should the bot support per-person aliases such as `Dad`, `Mom`, `Nani`, or phone-number mapping?
- Should the bot send a daily summary to the family group or only save silently?
- Should abnormal readings trigger alerts, and if so, what thresholds should be used?

## First Implementation Slice

1. Create WhatsApp Business bot number.
2. Expose Raspberry Pi service over HTTPS.
3. Receive incoming image webhook.
4. Download image media.
5. Parse image with OpenAI vision model.
6. Return structured JSON.
7. Save reading in Family OS backend.
8. Reply to sender with confirmation.

## Decision

Use a dedicated WhatsApp bot number named `Family Health Bot`.

Family members send or forward health-device photos to the bot. The system should not attempt to read the normal family WhatsApp group directly.

Prefer Meta WhatsApp Cloud API for long-term cost and control. Use Twilio only if speed of setup is more important than the small per-message markup.
