/**
 * Everything customers read, in English and Khmer: PDFs, the quote/invoice page, the email button, the website chat
 * widget, the video-call page, broadcast opt-outs and payment reminders. The workspace picks English, Khmer, or both (Settings → Quotes & invoices).
 *
 * Khmer wording: drafted for this CRM — have a native speaker review it; change it only here.
 */
export const CUSTOMER_LANGUAGES = ['en', 'km', 'both'] as const;
export type CustomerLanguage = (typeof CUSTOMER_LANGUAGES)[number];

const en = {
  quote: 'Quote', invoice: 'Invoice', number: 'Number', date: 'Date', dueDate: 'Due date', validUntil: 'Valid until', status: 'Status',
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', paid: 'Paid', void: 'Void',
  preparedFor: 'Prepared for', billTo: 'Bill to', item: 'Item', qty: 'Qty', unitPrice: 'Unit price', tax: 'Tax', amount: 'Amount',
  discount: 'Discount', subtotal: 'Subtotal', total: 'Total', paidAmount: 'Paid', balanceDue: 'Balance due', notes: 'Notes',
  page: 'Page {n} of {total}', each: '{price} each', issued: 'Issued {date}',
  payWithKhqr: 'Pay with KHQR', scanLine1: 'Scan with any Bakong member bank app', scanLine2: '(ABA, ACLEDA, Wing, Canadia, …) to pay this invoice.',
  scanHelp: 'Open your bank app (ABA, ACLEDA, Wing, …), choose Scan, and scan this code. On a phone, take a screenshot and use “scan from photo”.',
  to: 'To', downloadPdf: 'Download PDF', acceptQuote: 'Accept quote', decline: 'Decline', accept: 'Accept', cancel: 'Cancel', sending: 'Sending…',
  acceptTitle: 'Accept quote {number}', acceptHelp: 'You accept the quote for {total}. {seller} will be told right away.',
  fullName: 'Your full name', fullNameHint: 'Typed as your confirmation', noteOptional: 'Note (optional)', notePlaceholder: 'e.g. delivery date, PO number',
  declineTitle: 'Decline quote {number}', declineHelp: 'Telling us why helps us make a better offer.', reasonOptional: 'Reason (optional)',
  thanksAccepted: 'Thank you — the quote is accepted', thanksDeclined: 'Thanks for letting us know',
  acceptedBy: 'Accepted by {name} on {date}. Thank you — we’ll be in touch.', acceptedPlain: 'Accepted. Thank you — we’ll be in touch.',
  declinedNote: 'This quote was declined. Contact {seller} if you’d like a new one.', expiredNote: 'This quote has expired. Contact {seller} for a new one.',
  paidNote: 'Paid in full. Thank you!', voidNote: 'This invoice was cancelled.', questions: 'Questions? Reply to the email this link came with.',
  linkInvalid: 'This link isn’t valid any more. Ask for a new one.', cantOpen: 'Can’t open this document', somethingWrong: 'Something went wrong. Please try again.',
  viewAccept: 'View and accept online', viewPay: 'View and pay online',
  // Website chat widget
  chatOpen: 'Open chat', chatClose: 'Close chat', chatName: 'Your name (optional)', chatEmail: 'Email (optional)', chatMessage: 'Write a message…',
  chatSend: 'Send', chatAttach: 'Attach a photo or PDF', chatFile: 'Photo or PDF to send', chatTyping: '{name} is typing…', chatErrTooMany: 'Too many messages — please wait a minute.',
  chatErrSend: 'Your message could not be sent. Please try again.', chatErrType: 'Only photos (PNG, JPEG, GIF, WebP) and PDF files can be sent.',
  chatErrFiles: 'Too many files — please wait and try again later.', chatErrSize: 'Files can be up to 5 MB.', chatErrFile: 'The file could not be sent. Please try again.',
  // Video call (guest)
  callWith: 'Video call with {host}', callJoin: 'Join call', callEnterName: 'Enter your name to join', callYourName: 'Your name', callEnded: 'This call has ended',
  callThanks: 'Thanks for talking with {host}.', callCantOpen: 'Can’t open this call', callBadLink: 'This call link isn’t valid. Ask for a new one.',
  callMute: 'Mute', callUnmute: 'Unmute', callCamOff: 'Camera off', callCamOn: 'Camera on', callShare: 'Share screen', callStopShare: 'Stop sharing', callLeave: 'Leave',
  callWaiting: 'Waiting for others to join…', callYou: '{name} (you)', callLeft: 'You left the call', callRejoin: 'Rejoin', callJoining: 'Joining…', callMutedNote: 'muted', callSharingNote: 'sharing screen',
  // Broadcasts: STOP/START replies in chats, the email footer and the unsubscribe page
  optOutDone: 'You won’t get broadcast messages from {company} any more. Send START to get them again.',
  optInDone: 'You’ll get messages from {company} again. Send STOP to stop them.',
  unsubTitle: 'Unsubscribe from {company} emails', unsubButton: 'Unsubscribe', unsubUndo: 'Subscribe again',
  unsubHelp: 'You’ll stop getting news and offers from {company} at {email}. Invoices and replies to your messages still come.',
  unsubDone: 'You’re unsubscribed. You won’t get these emails any more.', unsubResubscribed: 'You’re subscribed again.',
  unsubFooter: 'You get this email because you’re a customer of {company}. Unsubscribe: {url}', unsubBadLink: 'This unsubscribe link isn’t valid.',
  // Payment reminders
  reminderSubject: 'Payment reminder: invoice {number} from {company}', reminderHello: 'Hello {name},',
  reminderBefore: 'Invoice {number} for {amount} is due on {date}.', reminderDue: 'Invoice {number} for {amount} is due today.',
  reminderAfter: 'Invoice {number} for {amount} was due on {date}.', reminderPaidAlready: 'If you have already paid, thank you — please ignore this message.',
  reminderLink: 'View and pay it here: {url}', reminderThanks: 'Thank you!',
  // Online booking
  bookMinutes: '{n} min', bookWith: 'with {host}', bookVideo: 'Video call — the link comes by email', bookPlace: 'At {place}',
  bookPickDay: 'Pick a day', bookPickTime: 'Pick a time', bookTz: 'Times are in {tz} time.', bookNoSlots: 'No free times in the next {n} days. Please contact us.',
  bookYourDetails: 'Your details', bookName: 'Your name', bookEmail: 'Email', bookPhone: 'Phone (optional)', bookNote: 'Anything we should know? (optional)',
  bookConfirm: 'Book {when}', bookBack: 'Change time', bookDone: 'You’re booked!', bookDoneHelp: 'We sent the details to {email}.',
  bookTaken: 'Sorry, someone just took this time. Please pick another.', bookBadLink: 'This booking link isn’t valid.',
  bookEmailSubject: 'Booked: {title} on {when}', bookEmailWhen: 'When: {when} ({tz} time), {n} minutes', bookEmailWith: 'With: {host}, {company}',
  bookEmailJoin: 'Join the video call', bookEmailWhere: 'Where: {place}', bookEmailCalendar: 'The attached file adds it to your calendar.',
  bookCancelLink: 'Need to cancel? {url}', bookCanceled: 'This booking was canceled.', bookCancel: 'Cancel booking', bookKeep: 'Keep it',
  bookCancelQ: 'Cancel your booking for {when}?', bookCancelDone: 'Your booking is canceled. {host} has been told.', bookPast: 'This booking has already taken place.',
  bookCanceledSubject: 'Canceled: {title} on {when}',
};
export type TextKey = keyof typeof en;

const km: Record<TextKey, string> = {
  quote: 'សម្រង់តម្លៃ', invoice: 'វិក្កយបត្រ', number: 'លេខ', date: 'កាលបរិច្ឆេទ', dueDate: 'ថ្ងៃផុតកំណត់', validUntil: 'មានសុពលភាពដល់', status: 'ស្ថានភាព',
  draft: 'សេចក្តីព្រាង', sent: 'បានផ្ញើ', accepted: 'បានទទួលយក', declined: 'បានបដិសេធ', paid: 'បានបង់រួច', void: 'បានលុបចោល',
  preparedFor: 'រៀបចំជូន', billTo: 'ចេញវិក្កយបត្រជូន', item: 'មុខទំនិញ', qty: 'ចំនួន', unitPrice: 'តម្លៃឯកតា', tax: 'ពន្ធ', amount: 'ទឹកប្រាក់',
  discount: 'បញ្ចុះតម្លៃ', subtotal: 'សរុបរង', total: 'សរុប', paidAmount: 'បានបង់', balanceDue: 'ទឹកប្រាក់ត្រូវបង់', notes: 'កំណត់សម្គាល់',
  page: 'ទំព័រ {n} នៃ {total}', each: '{price} ក្នុងមួយ', issued: 'ចេញថ្ងៃ {date}',
  payWithKhqr: 'បង់ប្រាក់តាម KHQR', scanLine1: 'ស្កេនដោយកម្មវិធីធនាគារណាមួយក្នុងប្រព័ន្ធបាគង', scanLine2: '(ABA, ACLEDA, Wing, Canadia, …) ដើម្បីបង់វិក្កយបត្រនេះ។',
  scanHelp: 'បើកកម្មវិធីធនាគាររបស់អ្នក (ABA, ACLEDA, Wing, …) ជ្រើសរើស «ស្កេន» ហើយស្កេនកូដនេះ។ នៅលើទូរស័ព្ទ អាចថតអេក្រង់ ហើយស្កេនពីរូបភាព។',
  to: 'ទៅកាន់', downloadPdf: 'ទាញយក PDF', acceptQuote: 'ទទួលយកសម្រង់តម្លៃ', decline: 'បដិសេធ', accept: 'ទទួលយក', cancel: 'បោះបង់', sending: 'កំពុងផ្ញើ…',
  acceptTitle: 'ទទួលយកសម្រង់តម្លៃ {number}', acceptHelp: 'អ្នកទទួលយកសម្រង់តម្លៃចំនួន {total}។ {seller} នឹងទទួលបានដំណឹងភ្លាមៗ។',
  fullName: 'ឈ្មោះពេញរបស់អ្នក', fullNameHint: 'វាយឈ្មោះ ដើម្បីបញ្ជាក់', noteOptional: 'កំណត់សម្គាល់ (មិនចាំបាច់)', notePlaceholder: 'ឧ. ថ្ងៃដឹកជញ្ជូន លេខបញ្ជាទិញ',
  declineTitle: 'បដិសេធសម្រង់តម្លៃ {number}', declineHelp: 'ការប្រាប់មូលហេតុ ជួយយើងរៀបចំការផ្តល់ជូនដែលល្អជាងនេះ។', reasonOptional: 'មូលហេតុ (មិនចាំបាច់)',
  thanksAccepted: 'សូមអរគុណ — សម្រង់តម្លៃត្រូវបានទទួលយក', thanksDeclined: 'សូមអរគុណដែលបានប្រាប់យើង',
  acceptedBy: 'ទទួលយកដោយ {name} នៅថ្ងៃ {date}។ សូមអរគុណ — យើងនឹងទាក់ទងទៅវិញ។', acceptedPlain: 'បានទទួលយក។ សូមអរគុណ — យើងនឹងទាក់ទងទៅវិញ។',
  declinedNote: 'សម្រង់តម្លៃនេះត្រូវបានបដិសេធ។ សូមទាក់ទង {seller} ប្រសិនបើអ្នកចង់បានសម្រង់តម្លៃថ្មី។', expiredNote: 'សម្រង់តម្លៃនេះផុតសុពលភាពហើយ។ សូមទាក់ទង {seller} ដើម្បីទទួលបានសម្រង់តម្លៃថ្មី។',
  paidNote: 'បានបង់គ្រប់ចំនួន។ សូមអរគុណ!', voidNote: 'វិក្កយបត្រនេះត្រូវបានលុបចោល។', questions: 'មានសំណួរ? សូមឆ្លើយតបអ៊ីមែលដែលមានតំណនេះ។',
  linkInvalid: 'តំណនេះលែងប្រើបានហើយ។ សូមស្នើសុំតំណថ្មី។', cantOpen: 'មិនអាចបើកឯកសារនេះបានទេ', somethingWrong: 'មានបញ្ហាកើតឡើង។ សូមព្យាយាមម្តងទៀត។',
  viewAccept: 'មើល និងទទួលយកតាមអនឡាញ', viewPay: 'មើល និងបង់ប្រាក់តាមអនឡាញ',
  chatOpen: 'បើកការជជែក', chatClose: 'បិទការជជែក', chatName: 'ឈ្មោះរបស់អ្នក (មិនចាំបាច់)', chatEmail: 'អ៊ីមែល (មិនចាំបាច់)', chatMessage: 'សរសេរសារ…',
  chatSend: 'ផ្ញើ', chatAttach: 'ភ្ជាប់រូបភាព ឬ PDF', chatFile: 'រូបភាព ឬ PDF ដែលត្រូវផ្ញើ', chatTyping: '{name} កំពុងសរសេរ…', chatErrTooMany: 'សារច្រើនពេក — សូមរង់ចាំមួយនាទី។',
  chatErrSend: 'មិនអាចផ្ញើសាររបស់អ្នកបានទេ។ សូមព្យាយាមម្តងទៀត។', chatErrType: 'អាចផ្ញើបានតែរូបភាព (PNG, JPEG, GIF, WebP) និងឯកសារ PDF ប៉ុណ្ណោះ។',
  chatErrFiles: 'ឯកសារច្រើនពេក — សូមរង់ចាំ ហើយព្យាយាមម្តងទៀតពេលក្រោយ។', chatErrSize: 'ឯកសារអាចមានទំហំរហូតដល់ 5 MB។', chatErrFile: 'មិនអាចផ្ញើឯកសារបានទេ។ សូមព្យាយាមម្តងទៀត។',
  callWith: 'ការហៅជាវីដេអូជាមួយ {host}', callJoin: 'ចូលរួមការហៅ', callEnterName: 'វាយឈ្មោះ ដើម្បីចូលរួម', callYourName: 'ឈ្មោះរបស់អ្នក', callEnded: 'ការហៅនេះបានបញ្ចប់ហើយ',
  callThanks: 'សូមអរគុណដែលបាននិយាយជាមួយ {host}។', callCantOpen: 'មិនអាចបើកការហៅនេះបានទេ', callBadLink: 'តំណការហៅនេះមិនត្រឹមត្រូវ។ សូមស្នើសុំតំណថ្មី។',
  callMute: 'បិទសំឡេង', callUnmute: 'បើកសំឡេង', callCamOff: 'បិទកាមេរ៉ា', callCamOn: 'បើកកាមេរ៉ា', callShare: 'ចែករំលែកអេក្រង់', callStopShare: 'ឈប់ចែករំលែក', callLeave: 'ចាកចេញ',
  callWaiting: 'កំពុងរង់ចាំអ្នកផ្សេងចូលរួម…', callYou: '{name} (អ្នក)', callLeft: 'អ្នកបានចាកចេញពីការហៅ', callRejoin: 'ចូលរួមម្តងទៀត', callJoining: 'កំពុងចូលរួម…', callMutedNote: 'បិទសំឡេង', callSharingNote: 'កំពុងចែករំលែកអេក្រង់',
  optOutDone: 'អ្នកនឹងលែងទទួលសារផ្សព្វផ្សាយពី {company} ទៀតហើយ។ ផ្ញើ START ដើម្បីទទួលវាម្តងទៀត។',
  optInDone: 'អ្នកនឹងទទួលសារពី {company} ម្តងទៀត។ ផ្ញើ STOP ដើម្បីឈប់ទទួល។',
  unsubTitle: 'ឈប់ទទួលអ៊ីមែលពី {company}', unsubButton: 'ឈប់ទទួល', unsubUndo: 'ទទួលម្តងទៀត',
  unsubHelp: 'អ្នកនឹងឈប់ទទួលព័ត៌មាន និងការផ្តល់ជូនពី {company} តាម {email}។ វិក្កយបត្រ និងការឆ្លើយតបនឹងសាររបស់អ្នក នៅតែផ្ញើមកដដែល។',
  unsubDone: 'អ្នកបានឈប់ទទួលហើយ។ អ្នកនឹងលែងទទួលអ៊ីមែលទាំងនេះទៀត។', unsubResubscribed: 'អ្នកបានចុះឈ្មោះទទួលម្តងទៀតហើយ។',
  unsubFooter: 'អ្នកទទួលអ៊ីមែលនេះ ព្រោះអ្នកជាអតិថិជនរបស់ {company}។ ឈប់ទទួល៖ {url}', unsubBadLink: 'តំណឈប់ទទួលនេះមិនត្រឹមត្រូវទេ។',
  reminderSubject: 'ការរំលឹកការបង់ប្រាក់៖ វិក្កយបត្រ {number} ពី {company}', reminderHello: 'ជម្រាបសួរ {name},',
  reminderBefore: 'វិក្កយបត្រ {number} ចំនួន {amount} ត្រូវបង់នៅថ្ងៃទី {date}។', reminderDue: 'វិក្កយបត្រ {number} ចំនួន {amount} ត្រូវបង់នៅថ្ងៃនេះ។',
  reminderAfter: 'វិក្កយបត្រ {number} ចំនួន {amount} ត្រូវបង់កាលពីថ្ងៃទី {date}។', reminderPaidAlready: 'ប្រសិនបើអ្នកបានបង់រួចហើយ សូមអរគុណ — សូមកុំខ្វល់នឹងសារនេះ។',
  reminderLink: 'មើល និងបង់ប្រាក់នៅទីនេះ៖ {url}', reminderThanks: 'សូមអរគុណ!',
  bookMinutes: '{n} នាទី', bookWith: 'ជាមួយ {host}', bookVideo: 'ការហៅជាវីដេអូ — តំណនឹងផ្ញើតាមអ៊ីមែល', bookPlace: 'នៅ {place}',
  bookPickDay: 'ជ្រើសរើសថ្ងៃ', bookPickTime: 'ជ្រើសរើសម៉ោង', bookTz: 'ម៉ោងទាំងនេះគិតតាមម៉ោង {tz}។', bookNoSlots: 'មិនមានម៉ោងទំនេរក្នុងរយៈពេល {n} ថ្ងៃខាងមុខទេ។ សូមទាក់ទងមកយើង។',
  bookYourDetails: 'ព័ត៌មានរបស់អ្នក', bookName: 'ឈ្មោះរបស់អ្នក', bookEmail: 'អ៊ីមែល', bookPhone: 'លេខទូរស័ព្ទ (ស្រេចចិត្ត)', bookNote: 'មានអ្វីដែលយើងគួរដឹងទេ? (ស្រេចចិត្ត)',
  bookConfirm: 'កក់ {when}', bookBack: 'ប្តូរម៉ោង', bookDone: 'អ្នកបានកក់រួចហើយ!', bookDoneHelp: 'យើងបានផ្ញើព័ត៌មានលម្អិតទៅ {email}។',
  bookTaken: 'សូមអភ័យទោស ម៉ោងនេះទើបតែមានគេកក់។ សូមជ្រើសរើសម៉ោងផ្សេង។', bookBadLink: 'តំណកក់នេះមិនត្រឹមត្រូវទេ។',
  bookEmailSubject: 'បានកក់៖ {title} នៅ {when}', bookEmailWhen: 'ពេលវេលា៖ {when} (ម៉ោង {tz}) រយៈពេល {n} នាទី', bookEmailWith: 'ជាមួយ៖ {host}, {company}',
  bookEmailJoin: 'ចូលរួមការហៅជាវីដេអូ', bookEmailWhere: 'ទីកន្លែង៖ {place}', bookEmailCalendar: 'ឯកសារភ្ជាប់នឹងបញ្ចូលវាទៅក្នុងប្រតិទិនរបស់អ្នក។',
  bookCancelLink: 'ចង់បោះបង់? {url}', bookCanceled: 'ការកក់នេះត្រូវបានបោះបង់។', bookCancel: 'បោះបង់ការកក់', bookKeep: 'រក្សាទុក',
  bookCancelQ: 'បោះបង់ការកក់របស់អ្នកនៅ {when}?', bookCancelDone: 'ការកក់របស់អ្នកត្រូវបានបោះបង់។ យើងបានជូនដំណឹងដល់ {host}។', bookPast: 'ការកក់នេះបានកន្លងផុតហើយ។',
  bookCanceledSubject: 'បានបោះបង់៖ {title} នៅ {when}',
};

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** One customer text: Khmer for "km" and "both" (sentences aren't doubled), English otherwise. */
export function ct(lang: CustomerLanguage, key: TextKey, vars?: Record<string, string | number>): string {
  return fill((lang === 'en' ? en : km)[key], vars);
}

/** A short label: for "both", "ខ្មែរ / English" (as on bilingual Cambodian invoices). */
export function ctLabel(lang: CustomerLanguage, key: TextKey, vars?: Record<string, string | number>): string {
  if (lang === 'both') return `${fill(km[key], vars)} / ${fill(en[key], vars)}`;
  return ct(lang, key, vars);
}

/** All texts for one language (the website chat widget gets these from the server). */
export const customerTexts = (lang: CustomerLanguage): Record<TextKey, string> => (lang === 'en' ? { ...en } : { ...km });

const KM_DAYS = ['ច័ន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍', 'អាទិត្យ'];
const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Short weekday of a date (YYYY-MM-DD): "Mon" or "ច័ន្ទ". */
export function customerWeekday(lang: CustomerLanguage, d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, day)).getUTCDay() + 6) % 7;
  return (lang === 'en' ? EN_DAYS : KM_DAYS)[wd];
}

const KM_MONTHS = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
/** A date (YYYY-MM-DD…) for customers: "Nov 18, 2026" or "18 វិច្ឆិកា 2026". */
export function customerDate(lang: CustomerLanguage, d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (lang !== 'en') return `${day} ${KM_MONTHS[m - 1]} ${y}`;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
