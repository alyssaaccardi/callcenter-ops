const Q = (text, type = 'yesno') => ({ text, type });
const ONE_THING = 'Write one specific example from this call of something that could have been improved, provide as much detail as possible.';

const NEW_SCENARIO = 'You are a new caller looking to hire this business for the service it offers';
const EXISTING_SCENARIO = 'You are an existing client following up on earlier work or a past matter';

module.exports = [
  {
    title: 'Pause While Spelling',
    objective: 'Whether the bot interrupts or waits for you to finish spelling out your name when taking pauses in between letters. Also testing if taking pauses in between letters affects the accuracy of the bot gathering information.',
    steps: [
      'Call the assigned account and connect as normal',
      'When the bot asks you to give your name, pause for 2-3 seconds in between the letters while spelling your name',
      'Spell your name slowly, with a clear pause in between letters',
      'If the bot interrupts or repeats the name back incorrectly, note when exactly the bot interrupted you, what you told the bot your name was and what the bot repeated back to you',
    ],
    call_notes: 'Take pauses in between letters before moving on to the next letter',
    variants: ['Call'],
    questions: [
      Q('Did the bot interrupt you while you were spelling your name?'),
      Q('Did the bot misunderstand your name?'),
      Q('How many times did you have to restart spelling your name? (If any)', 'text'),
      Q('If the bot had trouble, did the bot recover naturally or did it feel broken?'),
      Q('Would a real caller have stayed on the phone with the bot and proceeded with the intake?'),
    ],
    improvement_prompt: ONE_THING,
    default_scenarios: { Call: NEW_SCENARIO },
  },
  {
    title: 'Say Nothing At All',
    objective: 'Whether the bot stays on the call longer than 150 seconds (2 minutes and 30 seconds) or if the bot hangs up before the 150 second mark. The bot should ask you if you are still there at least twice before hanging up.',
    steps: [
      'Call the assigned account and connect as normal',
      'When the bot says the greeting and asks how they may help you, say nothing',
      'Do not give them your name or reason for calling, just stay silent',
      'Note the length of time that the bot stayed on the line with you after the greeting',
      'If at any point the bot hangs up, note the exact moment the bot hung up',
    ],
    call_notes: 'Stay silent for the entire call, do not say anything to the bot',
    variants: ['Call'],
    questions: [
      Q('Did the bot stay on the call longer than 150 seconds? If yes, how long? If no, when did the bot hang up?', 'text'),
      Q('How many times did the bot ask you if you were still there?', 'text'),
      Q('What was the length of the call?', 'text'),
    ],
    improvement_prompt: ONE_THING,
    default_scenarios: { Call: NEW_SCENARIO },
  },
  {
    title: 'Unanswered Question',
    objective: 'Whether the bot continues down the intake questions after you refuse to answer one of them. After refusing the first time, the bot should ask it once more, then move on to the next question.',
    steps: [
      'Call the assigned account and connect as normal',
      'When the bot asks you the third question, refuse or dodge the question',
      'Give the bot statements like "I don\'t want to answer that", "Why do you need to know that", "I don\'t feel comfortable answering that question"',
      'Push back if it repeats the question until it moves on to the next question',
      'If the bot does not move on to the next question, note that',
    ],
    call_notes: 'You are calling this company as a new client, wanting to hire them. As the bot goes through the intake questions, refuse or dodge 1-2 intake questions.',
    variants: ['Call'],
    questions: [
      Q('Did the bot move on to the next question after refusing to answer it?'),
      Q('Did the bot repeat the question multiple times? If so, how many?'),
      Q('Did the call feel natural after you refused to answer the question?'),
      Q('If the bot had trouble, did the bot recover naturally or did it feel broken?'),
      Q('Would a real caller have stayed on the phone with the bot and proceeded with the intake?'),
    ],
    improvement_prompt: ONE_THING,
    default_scenarios: { Call: NEW_SCENARIO },
  },
  {
    title: 'Recording Notice',
    objective: 'Whether the introduction from the bot sounds like one continuous opening, or like two separate, unnatural greetings. The bot should give a notice of recording and say the greeting of the company naturally and continuously.',
    steps: [
      'Call the assigned account and connect as normal',
      'When the bot says the greeting of the company, listen carefully to the opening statement',
      'Note if the greeting sounds natural',
    ],
    call_notes: 'Listen carefully to the greeting of the company and note if the greeting sounds like two separate greetings or if it sounds natural',
    variants: ['Call'],
    questions: [
      Q('Did the bot sound natural when giving the greeting and recording notice?'),
      Q('Did the call sound choppy or unnatural?'),
      Q('How does this greeting compare to the previous greetings without a recording notice?', 'text'),
    ],
    improvement_prompt: ONE_THING,
    default_scenarios: { Call: NEW_SCENARIO },
  },
  {
    title: 'Speak With Someone (No Reason Given)',
    objective: 'Whether the bot asks clarifying questions when a caller requests to speak with someone without explaining why they are calling, instead of only assuming the caller is an existing or new client.',
    steps: [
      'Call the assigned account and connect as normal',
      'Begin the conversation by saying "Hi, can I speak with {contact}?"',
      'Do not immediately explain why you are calling',
      'If the bot asks why you are calling, respond and give it a reason',
      'Continue the conversation and answer all of the intake questions',
    ],
    call_notes: 'Do not immediately say you are a new or existing client during your intro of the call. Be vague during the intro of the conversation. You will place TWO test calls: one as a New Client and one as an Existing Client, using the scenario shown for each.',
    variants: ['New Client', 'Existing Client'],
    questions: [
      Q('Did the bot ask you if you were a new or existing client immediately?'),
      Q('Did the bot identify the purpose of your call?'),
      Q('Did the conversation with the bot sound more natural than previous tests?'),
      Q('Would a real caller have stayed on the phone with the bot and proceeded with the intake questions?'),
    ],
    improvement_prompt: ONE_THING,
    default_scenarios: { 'New Client': NEW_SCENARIO, 'Existing Client': EXISTING_SCENARIO },
  },
];
