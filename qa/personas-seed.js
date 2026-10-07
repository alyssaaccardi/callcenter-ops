// ─── Round 1 persona scripts ─────────────────────────────────────────────────
// The call scripts already written for internal testing, one per call type.
// Each gives the tester a persona, a reason for calling, and the answers to
// give when the bot asks intake questions.
//
// "Your First Name", "Your Phone Number" and similar are deliberate: the tester
// supplies their own details so the bot is handling real, varied inputs rather
// than the same fabricated name every call.

// Shared briefing that heads every script in the source document.
const SHARED_GOAL = `These scripts simulate realistic inbound calls to our AI receptionist, to evaluate how well the bot handles a variety of caller types across law firm and field service practices.

Speak naturally — don't rush, don't read robotically, and don't make it easy on the bot. React the way a real person would if the bot stumbles.`;

const AL = '+16313814681';   // Law Office of Moira Rose
const RS = '+16312128447';   // Generic Plumbing

module.exports = {
  SHARED_GOAL,
  ACCOUNTS: [
    { name: 'Law Office of Moira Rose', phone_numbers: AL, brand: 'AL',
      general_notes: 'Answering Legal test account used for all law-firm call scripts in Round 1.' },
    { name: 'Generic Plumbing', phone_numbers: RS, brand: 'RS',
      general_notes: 'Ring Savvy / field services test account used for all HVAC and plumbing scripts in Round 1.' },
  ],

  // Call types the bot can transfer to the business owner. Transfer behaviour
  // is one of the things Round 1 is explicitly testing, so it is marked here
  // rather than left for a tester to guess.
  TRANSFER_CAPABLE: [
    'Traffic NC', 'PI NC', 'Divorce NC', 'Med Mal NC', 'Court Call', 'HVAC NC', 'Criminal NC',
  ],

  PERSONAS: [
    { call_type: 'Traffic NC', brand: 'AL', title: 'New Client Traffic', phone: AL,
      persona: "You got a speeding ticket last week doing 87 in a 30. Your license is already close to suspension and you're worried about points. This is your first time calling a lawyer for anything.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone number', 'Your Phone Number'], ['Email', 'Your Email'],
        ['Date of Birth', 'Your Date of Birth'],
        ['What is the violation?', 'Speeding'],
        ['What is the violation number', '3355248'],
        ['What city/county did this take place?', 'Suffolk County'],
        ['When is your next court date?', '8/2/2026'],
        ['How did you hear about us?', 'Friend John Styles'],
      ]},

    { call_type: 'PI NC', brand: 'AL', title: 'New Client Personal Injury', phone: AL,
      persona: "You were in a car accident last Wednesday in Hauppauge, New York. You suffered a broken spine and had to go to the hospital near the accident. A friend told you to call a lawyer before talking to the other driver's insurance company.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What type of accident?', 'Car accident'],
        ['When did the accident occur?', 'Last Wednesday'],
        ['Where did the accident happen (City/State)?', 'Hauppauge, New York'],
        ['What injuries did you sustain?', 'Broken Spine'],
        ['Did anyone go to the hospital or receive any treatment?', 'Yes I did'],
        ['If so, by whom/where', 'I went to the hospital up the road from the accident'],
      ]},

    { call_type: 'Divorce NC', brand: 'AL', title: 'New Client Divorce', phone: AL,
      persona: "You've been separated from your husband/wife for six months and you're ready to file for divorce. You don't have any kids but you do have a shared house and bank accounts. This is your first time dealing with anything like this and you're a little nervous.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['Is the divorce contested or uncontested?', 'Contested'],
        ['Do you have any children together?', 'No'],
        ['Do you own any property together?', 'Yes our house'],
        ['Are you still living in the same household?', 'No'],
        ['What city do you currently reside/live in?', 'Your hometown city'],
        ['Name of opposing counsel/parties', 'Anthony Grandinetti'],
        ['Have you been served any paperwork or have a court date pending?', 'Yes'],
        ['What is the court date', '9/2/2026'],
        ['How did you hear about us?', 'Google'],
      ]},

    { call_type: 'Med Mal NC', brand: 'AL', title: 'New Client Medical Malpractice', phone: AL,
      persona: "You had knee surgery about three months ago and your recovery has been unusually painful. Your follow-up doctor thinks the original surgeon may have made an error. You're looking for a second opinion on whether you actually have a case.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What type of alleged malpractice is this about?', 'A surgical error during knee surgery'],
        ['What date did the alleged malpractice occur?', '3 months ago'],
        ['What is the name of the facility/doctor this took place with?', 'Dr. Smith'],
        ['What injuries do you have as a result of this alleged malpractice?', "Unusual and ongoing pain since the surgery. I can't walk"],
        ['Are the injuries sustained due to the alleged malpractice permanent?', "I don't know that's part of why I'm calling"],
        ['How did you hear about the firm?', 'Friend John Styles'],
      ],
      note: "Two answers are deliberately vague — “3 months ago” and “I don't know” — to test how the bot handles a caller who cannot answer an intake question precisely."},

    { call_type: 'Criminal NC', brand: 'AL', title: 'New Client Criminal', phone: AL,
      persona: "Your friend was arrested over the weekend for assault. They have a court date in two weeks and neither of you have ever dealt with the legal system before. You're calling on their behalf because they're still in custody and you're trying to figure out what to do.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['Date of arrest', '4/12/2026'],
        ['What were you charged with?', 'Assault'],
        ['What city/county and state did this take place in?', 'Smithtown, New York. No idea what county that is'],
        ['When is your next court date', "2 Monday's from now"],
        ['Are you calling for yourself or on behalf of someone else?', 'Someone else'],
        ['Is the potential new client in custody?', "Yes that's why I'm calling"],
        ['Which facility?', 'Riverhead'],
        ['How did you hear about us?', 'Google'],
      ],
      note: 'Third-party caller. Also tests a caller who does not know their county, and a relative date instead of a calendar one.'},

    { call_type: 'Other NC', brand: 'AL', title: 'Generic New Client', phone: AL,
      persona: "You have a situation with a contractor who did bad work on your house and you're looking to sue the company. You're not sure if you can, so you called the law firm to find out.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What type of matter is this in regards to?', 'Not too sure. I had a dispute with a contractor who did a bad job and I want to sue them'],
        ['How did you hear about us?', 'Google'],
      ],
      note: 'Caller cannot name their own matter type — tests whether the bot can classify an unclear case.'},

    { call_type: 'Existing Client', brand: 'AL', title: 'Existing Client', phone: AL,
      persona: "You're an existing client with an open personal injury case at the firm. You haven't heard from your attorney in about three weeks and you're just trying to get a status update. You don't want to be a bother but it's been a while and you'd really like to know where things stand.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What type of matter is this in regards to?', "Haven't heard from the attorney in 3 weeks about my personal injury case and I want an update"],
      ]},

    { call_type: 'General Call', brand: 'AL', title: 'General Inquiry', phone: AL,
      persona: "You're calling to find out what types of cases the firm handles. You don't have a specific legal issue yet but you wanted to get a feel for what they do before anything comes up.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What type of matter is this in regards to?', "I'm just calling to find out what kinds of cases you handle"],
      ]},

    { call_type: 'Court Call', brand: 'AL', title: 'Court Call', phone: AL,
      persona: "You're calling from Judge Patricia Alvarez's chambers at Cook County Circuit Court. You need to reach the attorney of record to let them know a hearing has been rescheduled. You just need to leave a clear message with the details.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['What case/client are you inquiring about?', 'Ben Shatles'],
        ['What Court House are you calling from?', 'Cook County Circuit Court'],
      ]},

    { call_type: 'Spam Call', brand: 'AL', title: 'Spam Call', phone: AL,
      persona: "You're an answering service cold caller trying to speak with the owner of the business.",
      opening_line: 'This is {YOUR NAME} from NY Answering service and I was just calling to introduce the owner to my company',
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
      ],
      note: 'Intake answers only if asked.',
      special_instruction: 'Record in your submission whether the bot asked contact/intake questions after you began the call as a solicitor.'},

    { call_type: 'HVAC NC', brand: 'RS', title: 'HVAC New Client', phone: RS,
      persona: "Your AC stopped working yesterday and the house is getting unbearable. You found this company online and you're hoping to get someone out as soon as possible.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['Address/City/State/Zip', 'Your Address/City/State/Zip'],
      ]},

    { call_type: 'HVAC EC', brand: 'RS', title: 'HVAC Existing Client', phone: RS,
      persona: "You had your AC unit serviced last week and it's still not cooling properly. You're calling back because the problem wasn't fixed and you want someone to come take another look.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'],
        ['Description of the issue', "AC unit serviced last week and it's still not cooling properly"],
      ]},

    { call_type: 'Plumbing New Client', brand: 'RS', title: 'Plumbing New Client', phone: RS,
      persona: "You have a pipe under your kitchen sink that's been leaking since this morning. It's not a full emergency but it's getting worse and you need someone to come out and fix it.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'], ['Email Address', 'Your Email address'],
        ['Address/City/State/Zip', 'Your Address/City/State/Zip'],
      ]},

    { call_type: 'Plumbing EC', brand: 'RS', title: 'Plumbing Existing Client', phone: RS,
      persona: "You had a plumber out two days ago to fix a leaking pipe and you're still seeing water. You're calling back to let them know the issue isn't resolved and you need someone to come back out.",
      answers: [
        ['First Name', 'Your First Name'], ['Last Name', 'Your Last Name'],
        ['Phone Number', 'Your Phone Number'],
        ['Description of the issue', "You fixed a leaking pipe 2 days ago and it's still leaking"],
      ]},
  ],
};
