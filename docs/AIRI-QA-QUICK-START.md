# AIRI QA: Quick Start For QA Agents

This guide is for QA Agents who use AIRI QA to listen to calls, record what happened, and flag problems. You do not need to know how the software is built.

## What This Tool Is For

AIRI QA is the team’s shared place to review AIRI calls. It helps us spot what is working, record problems consistently, and make sure serious issues are followed up.

It does not change the bot or fix a customer’s phone setup. A review records what you heard so the right person can investigate.

## Review A Call

1. Open AIRI QA and choose **Review queue**.
2. Use the search box to find an account, caller ID, date, or QA Agent. Choose a status filter if needed; select a column heading to sort the list.
3. Select a call. Check the account and call time so you know you opened the right one.
4. Listen to the recording all the way through when possible.
5. Choose the caller rating and any flags that clearly match what happened. Add a short note when it will help someone follow up.
6. Mark the review complete when you have recorded what you found.

Be fair and specific. Record what you heard, not what you think might have happened. For example, write “Caller asked twice to speak with a person; bot repeated the greeting” rather than “Bot was bad.”

### If A Call Is Already Being Reviewed

The app may show that another teammate has the call open. Check with them before taking it over so two people do not do the same work. If you need to stop before finishing, your saved work stays with the call.

## What “Critical” Means

Use a critical flag for a serious problem that needs attention, and explain the problem in the note. A critical call appears in the critical queue for follow-up.

C-level executives may use **Critical** to request immediate attention from the appropriate team. Include a clear reason, and also contact that team through the normal urgent escalation channel. The flag puts the call in AIRI QA’s critical queue; it does not automatically page or message anyone. Use it for serious issues, not as a general priority marker.

Critical is attached to one call, not permanently to the whole company. If the issue on that call is addressed and an authorized QA Agent clears its critical flag, that call is no longer critical. Other calls for the same company are unchanged.

## Forwarding Checks

Sometimes an active AIRI account has gone quiet for a while. After 36 business hours without a call, AIRI QA may show it as due for a forwarding test. Business hours are weekdays, 9 a.m. to 5 p.m. Eastern Time.

1. Open **Forwarding checks**. Admins can also see the due list in **Team overview**.
2. Select the account name to open its HubSpot deal. Check the forwarding number and provider details shown there.
3. Place the agreed test call.
4. Choose **Reached AIRI** if it connected to AIRI, or **Did not reach AIRI** if it did not. Add a brief note if helpful, then save the result.

If the test did not reach AIRI, the call is marked critical so the team can follow up. This affects that call only. Do not mark a result unless you actually placed the test.

## HubSpot And Missing Accounts

HubSpot helps AIRI QA confirm which accounts are in the AIRI onboarding process and provides the forwarding details. The app may not connect a recording to a deal if the names do not clearly match. It avoids guessing when names are unclear.

If an account should be there but is missing from a forwarding list, ask an AIRI QA admin to check the HubSpot deal and company name. Do not rename recording folders or guess which deal is correct.

Some HubSpot stages are not eligible for AIRI QA workflows. You do not need to interpret or change deal stages; ask an admin if eligibility looks wrong.

## Internal Test Calls

Admins maintain **Admin settings → Internal test numbers**. Any call from a listed number is automatically flagged as an **Internal test call**, including calls made before the number was added. Flagged calls are hidden from the Review queue by default and are left out of counts and reports. To see them, set the queue's **Internal tests** filter to Include or Only; they show an "Internal test call" badge. Nothing is deleted.

Only an admin should add or remove numbers. Add a number only after confirming it belongs to an internal test caller. If a real customer call seems to be hidden, tell an admin so they can check the list.

Caller numbers are read from the recording room name when it follows the expected pattern. Some recordings are anonymous, so no caller number can be shown. The recording data does not reliably tell us the number the call was placed to; do not guess it.

## Team Focus

Admins manage shared **Team focus** posts in **Admin settings**. Add a new post without replacing older ones, choose Bug, Watch, or Test, and optionally set an expiration date. Admins can remove an individual post. QA Agents see up to the three newest unexpired posts; the newest stands out most, and posts added in the last week are marked **NEW**.

**Team overview** is admin-only. Admins can use **View as QA Agent** in Admin settings to preview the QA Agent queue. Preview is read-only: it does not claim calls, save changes, show admin tools, or grant another person access.

## When Something Looks Wrong

Do not try to work around a problem by changing the review or account details. Tell your lead or an AIRI QA admin and include:

- What you were trying to do and what happened.
- The account name and approximate call time.
- Which AIRI QA screen you were on.
- The exact message shown, if there was one.

Never put passwords, access codes, full transcripts, or downloaded recordings in a general team message. Ask an admin where to send sensitive information.

Examples to report:

- A recording is missing, silent, or belongs to a different account.
- The account opens the wrong HubSpot deal or cannot be found.
- A forwarding result will not save.
- A call appears critical for the wrong reason, or a serious problem is not flagged.
- A real customer call appears to be hidden as an internal test.

## Trainer Walkthrough

For a new teammate, demonstrate these in order:

**Simple explanation for the team:** “Listen to the call, write down what happened, and flag a problem if you clearly hear one. AIRI QA saves what we found so the right person can follow up. It does not fix the bot or the customer’s phone service.”

1. Open a training-approved call and confirm its account and time.
2. Listen, choose a caller rating, add a clear note, and complete the review.
3. Find the critical queue and explain that critical flags need a written reason.
4. Show a forwarding check and explain both possible results. Use an approved test account; do not place an unplanned test call.
5. Explain that internal-test numbers are managed by admins and hidden for everyone.
6. Ask the trainee to complete one supervised review and explain how they would report a missing or incorrect call.

Before the trainee works independently, confirm they know to protect caller information, avoid guessing, and ask for help when something does not match.

## For Admins And Bug Investigators

For the behind-the-scenes explanation of recordings, HubSpot matching, admin tools, known limitations, and troubleshooting, see the [AIRI QA Team Guide](AIRI-QA-TEAM-GUIDE.md).