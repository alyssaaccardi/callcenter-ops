# AIRI QA Review Criteria

This guide defines when to complete a review, when to explicitly mark **Needs Follow Up**, and when to raise a **Critical** flag. Record only what is supported by the call recording. A flag sends work to the appropriate team; it does not page anyone or fix the issue.

## Complete A Review

Before completing a call review:

- Confirm the account and call time match the recording you listened to.
- Listen to enough of the recording to judge the caller's interaction with AIRI.
- Select caller signals only when they are clearly supported by what you heard.
- Add a concise, factual note when context is needed to explain a rating, signal, or escalation.

A neutral or positive call can be marked **Reviewed** without follow-up. Sales/spam, greeting-only, or no-interaction signals alone do not automatically mean the call needs follow-up.

## Needs Follow Up

Click **Mark Needs Follow Up** when the recording contains a specific, credible issue that requires someone to investigate, correct, or contact the customer. Examples include:

- AIRI misunderstood the caller's request and did not recover.
- AIRI gave information that appears incorrect or materially incomplete.
- A transfer or human response was needed but did not happen.
- The caller ended the call in a way that indicates a likely bot-related failure.
- Another clearly heard issue needs product, operations, or account-owner action.

Before marking follow-up, add at least one relevant caller signal or a short note describing the evidence and what should be checked. Do not use follow-up solely because the caller sounded unhappy, the call was short, or you are uncertain what happened. If uncertain, document the uncertainty and ask a lead.

## Critical Flags

Use **Flag critical issue** only for a serious, time-sensitive, or high-impact failure that needs prompt admin or product-team attention. Examples include:

- AIRI repeatedly provides materially wrong information that could cause harm or a significant customer impact.
- A clearly urgent caller need is mishandled and no effective escalation occurs.
- A severe system or routing failure prevents callers from reaching the intended service.
- A confirmed pattern or single incident presents immediate business, safety, or compliance risk.

A critical flag always requires a specific note stating what happened, why it is urgent or high impact, and what needs attention. If the issue is important but not urgent or high impact, use **Needs Follow Up** instead. Do not use Critical as a general priority marker. For an urgent customer impact, also use the normal escalation channel; AIRI QA does not page or message responders.

## After A Critical Issue Is Addressed

An admin reviews the open **Critical Flags** list. Only after confirming that the appropriate admin or product team has addressed the concern should an admin select **Mark addressed**. This clears the active critical flag, records the resolver and time in call history, and returns the call to **Reviewed**. It does not delete the original critical note or audit history.

## Writing Useful Notes

Prefer observable facts and a next step:

> Caller asked twice to speak with a person; AIRI repeated the greeting. Please check why the handoff did not start.

Avoid unsupported conclusions, personal judgments, or guesses about caller intent. Protect caller information; do not copy credentials, access codes, or full transcripts into general notes.
