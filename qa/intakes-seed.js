// ─── Templated intake scripts ────────────────────────────────────────────────
// The intake forms already configured in the receptionist platform, by call
// type. Stored as structured fields rather than a text blob so a test brief can
// reference exactly which fields an intake captures, and so the Intakes tab can
// render them consistently.
//
// `d(...)` marks a dropdown and its options; everything else is free text.

const d = (label, ...options) => ({ label, type: 'dropdown', options });
const t = (label) => ({ label, type: 'text' });

const NAME_PHONE = [t('First Name'), t('Last Name'), t('Phone Number')];

module.exports = [
  { name: 'Criminal', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email Address'), t('Date of Arrest'),
    t('What were you charged with?'),
    t('What City/County and State did this take place in?'),
    t('When is your next court date?'),
    d('Are you calling for yourself or on behalf of someone else?', 'Client', 'Someone calling on behalf of client'),
    t('If someone is calling other than the client, is the potential new client in custody?'),
    t('If Yes, which facility?'), t('Message'), t('How did you hear about us?'),
  ]},

  { name: 'Traffic Tickets', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email'), t('Date of Birth'), t('Message'),
    t('What is the violation?'), t('What is the violation number?'),
    t('What City & County did this take place in?'),
    t('When is your next court date?'), t('How did you hear about us?'),
  ]},

  { name: 'Personal Injury', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email Address'), t('What type of accident?'),
    t('When did the accident occur?'),
    t('Where did the accident happen (City/State)?'),
    t('What injuries did you sustain?'),
    t('Did anyone go to the hospital or receive any treatment?'),
    t('If so, by whom/where? i.e. ER via ambulance, Urgent Care, Primary Care, etc.'),
    t('Message'),
  ]},

  { name: 'Divorce', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email'),
    d('Is the divorce contested or uncontested?', 'Contested', 'Uncontested'),
    d('Do you have any children together?', 'Yes', 'No'),
    d('Do you own any property together?', 'Yes', 'No'),
    d('Are you still living in the same household?', 'Yes', 'No'),
    t('What city do you currently reside/live in?'),
    t('Name of opposing counsel/parties (for conflict check)'),
    t('Have you been served any paperwork or have a court date pending?'),
    t('If Yes, what is the court date?'), t('Message'), t('How did you hear about us?'),
  ]},

  { name: 'Child Custody', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email'), t('Message'),
    t('Where did the incident take place?'),
    d('Is there a court order currently in place?', 'Yes', 'No', 'N/A'),
    t('If so, what county and state are the orders in?'),
    t('What county do the children live in?'),
    t('What city do you currently reside/live in?'),
    t('How many children are involved?'), t('How old are the children?'),
    t('Where have the children been residing the last 6 months?'),
    t('Are there contested property issues?'),
    t('Name of opposing counsel/party (for conflict check)'),
    t('How long has this order been in place?'),
    t('Is it being performed, or is it in default?'), t('If so, for how long?'),
    t('What is the best time to call you back?'), t('How did you hear about us?'),
  ]},

  { name: 'Bankruptcy', brand: 'AL', fields: [
    ...NAME_PHONE, t('Message'),
    d('Are your bank accounts frozen or about to be?', 'Yes', 'No'),
    d('Are your wages being garnished, or about to be garnished?',
      "They're currently being garnished", 'They are about to be garnished', 'No', 'Caller is unsure'),
    d('Is your house in foreclosure?', 'Yes', 'No'),
    d('If Yes, is the sale date imminent?', 'Yes', 'No'),
    d('Are you married?', 'Yes', 'No'),
    d('If Yes, are you filing jointly?', 'Yes', 'No', 'N/A'),
  ]},

  { name: 'Immigration', brand: 'AL', fields: [
    t('First Name'), t('Middle Name'), t('Last Name'), t('Suffix (if available)'),
    t('Phone Number'), t('Email Address'), t('Alien Number'),
    t('What is the specific immigration issue you need help with?'), t('Message'),
  ]},

  { name: 'Real Estate', brand: 'AL', fields: [
    ...NAME_PHONE, t('Message'), t('Property Address'),
    t('Is this a mobile home or Section 8 housing?'),
    t('What county and state is the property located in?'),
    t('Is it a commercial or residential property?'),
    d('Is there a dispute regarding this property?', 'Yes', 'No', 'N/A'),
    t('If Yes, what is the nature of the dispute?'),
    d('What type of Real Estate transaction is this?', 'Buying', 'Selling', 'Refinancing', 'Other'),
    d('If purchasing a property, is there a lender involved or will this be a cash purchase?',
      'Lender', 'Cash Purchase', 'N/A'),
    t('Who is your broker?'), t('What is the best time to call you back?'),
    t('How did you hear about us?'),
  ]},

  { name: 'Med Mal', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email'),
    t('What type of alleged malpractice is this about?'),
    t('What date did the alleged malpractice occur?'),
    t('What is the name of the facility/doctor this took place with?'),
    t('What injuries do you have as a result of this alleged malpractice?'),
    t('Are the injuries you sustained due to the alleged malpractice permanent?'),
    t('Message'), t('How did you hear about the firm?'),
  ]},

  // Pasted under three headings sharing one field list — kept as one intake.
  { name: 'New Client / Wills, Trusts, Estates & Probate / Family', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email Address'),
    t('What type of matter is this in regards to?'),
    t('Message'), t('How did you hear about us?'),
  ]},

  { name: 'Courts', brand: 'AL', fields: [
    ...NAME_PHONE, t('Email'),
    t('What case/client are you inquiring about?'),
    t('What courthouse are you calling from?'), t('Message'),
  ]},

  { name: 'Judges', brand: 'AL', fields: [...NAME_PHONE, t('Message')] },

  { name: 'Opposing Counsel', brand: 'AL', fields: [...NAME_PHONE, t('Message')] },

  { name: 'Insurance Adjusters', brand: 'AL', fields: [
    ...NAME_PHONE, t('What case/client are they calling about?'),
    t('What is the file/index/claim number?'), t('Message'),
  ]},

  { name: 'Medical Providers', brand: 'AL', fields: [
    ...NAME_PHONE, t('What case/client are they calling about?'),
    t('What is the file/index/claim number?'), t('Message'),
  ]},

  { name: 'Government Agencies', brand: 'AL', fields: [
    ...NAME_PHONE, t('What agency are you calling from?'),
    t('Client name and/or case number'), t('Message'),
  ]},

  { name: 'General Contractor – Default', brand: 'RS', fields: [
    ...NAME_PHONE, t('Email'), t('Address'), t('City'), t('State'), t('Zip'),
    t('How did you hear about us'), t('Message'),
  ]},

  { name: 'General Contractor – Emergency', brand: 'RS', fields: [
    t('Is this an emergency'), ...NAME_PHONE, t('Address'), t('City'), t('State'),
    t('Zip'), t('Email'), t('How did you hear about us'), t('Message'),
  ]},

  { name: 'General Contractor – Simple', brand: 'RS', fields: [
    ...NAME_PHONE, t('Address'), t('City'), t('State'), t('Zip'), t('Message'),
  ]},

  { name: 'General Contractor – Simple + Email', brand: 'RS', fields: [
    ...NAME_PHONE, t('Email'), t('Address'), t('City'), t('State'), t('Zip'), t('Message'),
  ]},

  { name: 'General Contractor – New / Returning Customer', brand: 'RS', fields: [
    ...NAME_PHONE, t('Address'), t('City'), t('State'), t('Zip'), t('Email'),
    t('Have you used us before?'),
    t('If so, when was the last time we serviced you?'),
    t('Are you having the same issues as the last time we serviced you?'),
    t('How did you hear about us?'), t('Message'),
  ]},

  { name: 'General Contractor – Emergency Existing', brand: 'RS', fields: [
    t('Is this an emergency'), ...NAME_PHONE, t('Address'), t('City'), t('State'),
    t('Zip'), t('Email'), t('How did you hear about us'), t('Message'),
  ]},
];
