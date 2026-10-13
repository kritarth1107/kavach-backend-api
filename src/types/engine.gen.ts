// Generated from kawach-ai-engine contracts/*.schema.json by scripts/contract_types.mjs. Do not edit by hand.
// The shapes are learnt from the synthetic test world; a field marked optional was missing in some responses.

export interface AdminCareRecord {
facts: {
confidence: number
domain: string
key: string
links: unknown[]
recordedAt: string
source: string
status: string
text: string
validTo: (null | string)
versionId: number
}[]
}

export interface AdminLive {
alerts: unknown[]
comingUp: {
at: string
familyId: string
kind: string
personId: {
[k: string]: unknown
}
}[]
conversations: unknown[]
now: string
outreach: unknown[]
tasks: unknown[]
windowMinutes: number
}

export interface DashBoundaries {
approvers: {
id: string
name: string
}[]
categories: string[]
members: {
id: string
name: string
role: string
}[]
monthSpent: number
plain: string
policy: {
anyone_over: {
[k: string]: unknown
}
approval_categories: unknown[]
approvers: unknown[]
elder_order_limit: number
elder_ride_limit: number
login_codes: Record<string, unknown>
members: Record<string, unknown>
monthly_cap: {
[k: string]: unknown
}
}
waiting: unknown[]
}

export interface DashCareTeam {
contacts: unknown[]
doctors: {
name: string
phone: string
speciality: string
text: string
}[]
helpers: {
name: string
phone: string
text: string
}[]
hospital: {
address: {
[k: string]: unknown
}
name: string
phone: {
[k: string]: unknown
}
text: string
}[]
past: {
doctor: string
key: string
place: string
purpose: string
questions: string[]
status: string
text: string
upcoming: boolean
when: string
}[]
upcoming: {
doctor: string
key: string
place: string
purpose: string
questions: string[]
status: string
text: string
upcoming: boolean
when: string
}[]
}

export interface DashEmergency {
allergies: {
allergen: string
reaction: {
[k: string]: unknown
}
text: string
}[]
conditions: string[]
contacts: unknown[]
diet: string[]
doctors: {
name: string
phone: string
speciality: string
text: string
}[]
familyRules: unknown[]
home: {
[k: string]: unknown
}
hospital: {
address: {
[k: string]: unknown
}
name: string
phone: {
[k: string]: unknown
}
text: string
}[]
medicines: {
dose: string
name: string
text: string
times: string[]
}[]
none: {
allergy: boolean
condition: boolean
medicine: boolean
}
profile: {
blood_group?: string
}
}

export interface DashEvents {
events: {
actorId: string
at: string
day: string
id: number
kind: string
payload: {
day?: string
key?: string
kind?: string
label?: string
medicine?: string
score?: number
source?: string
time?: string
unit?: string
value?: string
word?: string
}
summary: string
}[]
}

export interface DashFamilyTasks {
tasks: unknown[]
}

export interface DashHome {
doses: {
dose: string
id: string
name: string
status: string
time: string
}[]
followUps: {
createdAt: string
detail: {
activity_key?: string
date?: string
}
id: string
kind: string
ownerId: {
[k: string]: unknown
}
rule: {
[k: string]: unknown
}
status: string
title: string
wakeAt: string
}[]
lastHeardAt: (null | string)
mood: (null | {
at: string
score: number
source: string
summary: string
word: string
})
needsYou: {
id: string
key?: string
kind: string
meta: string
title: string
}[]
nextAppointment: (null | {
doctor: string
key: string
place: string
purpose: string
questions: string[]
status: string
text: string
upcoming: boolean
when: string
})
now: string
tasks: unknown[]
timeline: unknown[]
vitals: {
bp: (null | {
at: string
change: {
dir: string
pct: number
}
redFlag: {
[k: string]: unknown
}
trend: number[]
unit: string
value: string
})
spo2: (null | {
at: string
change: (null | {
dir: string
pct: number
})
redFlag: {
[k: string]: unknown
}
trend: number[]
unit: string
value: string
})
sugar: {
[k: string]: unknown
}
temperature: (null | {
at: string
change: {
[k: string]: unknown
}
redFlag: {
[k: string]: unknown
}
trend: number[]
unit: string
value: string
})
weight: (null | {
at: string
change: {
[k: string]: unknown
}
redFlag: {
[k: string]: unknown
}
trend: number[]
unit: string
value: string
})
}
week: {
adherence: number[]
days: string[]
scheduled: number
streakDays: number
taken: number
}
}

export interface DashMemoryHealth {
forgotten: unknown[]
issues: {
ask: string
key: string
kind: string
problem: string
}[]
profileCard: {
[k: string]: unknown
}
}

export interface DashMemoryHistory {
changes: {
actorId: (null | string)
added?: string[]
at: string
body: string
by: string
canRestore: boolean
canUndo: boolean
deleted: boolean
id: number
kind: string
label: string
more?: number
op: string
reason: string
removed?: unknown[]
source: string
status: (null | string)
subjectId: string
summary: string
target: string
title: string
undoes: {
[k: string]: unknown
}
value?: {
days?: number[]
doctor?: string
dose?: string
food?: string
instructions?: string
item?: string
kind?: string
label?: string
language?: string
minutes?: number
name?: string
none?: boolean
phone?: string
place?: string
prn?: boolean
purpose?: string
questions?: string[]
rule?: string
specialty?: string
start?: string
status?: string
times?: string[]
type?: string
value?: string
when?: string
}
version: number
where: string
}[]
}

export interface DashOutcomes {
consent: {
at: {
[k: string]: unknown
}
by: {
[k: string]: unknown
}
granted: boolean
}
kinds: {
all_fine: string
doctor_visit: string
er_visit: string
fall: string
hospital_visit: string
medicine_changed: string
other: string
recovered: string
}
outcomes: unknown[]
}

export interface DashOverview {
day: string
domains: {
activity: string
allergy: string
appointment: string
condition: string
contact: string
diet: string
dish: string
doctor: string
family: string
home: string
hospital: string
language: string
medicine: string
naming: string
no_order: string
occasion: string
preference: string
profile: string
routine: string
vital_target: string
}
doses: {
dose: string
id: string
name: string
status: string
time: string
}[]
events: {
actorId: (null | string)
at: string
day: string
id: number
kind: string
payload: {
day?: string
key?: string
kind?: string
label?: string
medicine?: string
score?: number
source?: string
time?: string
unit?: string
value?: string
word?: string
}
summary: string
}[]
facts: {
confidence: number
confirmedBy: (null | string)
domain: string
id: string
key: string
links: unknown[]
name: string
note: {
[k: string]: unknown
}
recordedAt: string
source: string
statedBy: (null | string)
status: string
text: string
validFrom: string
validTo: {
[k: string]: unknown
}
value: {
days?: number[]
doctor?: string
dose?: string
food?: string
instructions?: string
item?: string
kind?: string
label?: string
language?: string
minutes?: number
name?: string
none?: boolean
phone?: string
place?: string
prn?: boolean
purpose?: string
questions?: string[]
rule?: string
specialty?: string
start?: string
status?: string
times?: string[]
type?: string
value?: string
when?: string
}
}[]
loops: {
createdAt: string
detail: {
activity_key?: string
date?: string
fact_id?: string
key?: string
new?: {
days?: number[]
dose: string
food: string
instructions?: string
name: string
prn?: boolean
times?: string[]
}
old?: {
days?: number[]
dose: string
food: string
name: string
prn?: boolean
times?: string[]
}
}
id: string
kind: string
ownerId: {
[k: string]: unknown
}
rule: {
[k: string]: unknown
}
status: string
title: string
wakeAt: (null | string)
}[]
notes: {
body: string
slug: string
subjectId: string
title: string
updatedAt: string
version: number
}[]
pending: {
confidence: number
confirmedBy: {
[k: string]: unknown
}
domain: string
id: string
key: string
name: string
note: {
[k: string]: unknown
}
recordedAt: string
source: string
statedBy: (null | string)
status: string
text: string
validFrom: string
validTo: {
[k: string]: unknown
}
value: {
days?: number[]
dose: string
food: string
instructions?: string
name: string
prn?: boolean
times?: string[]
}
}[]
tasks: unknown[]
}

export interface DashPatterns {
patterns: {
detail: string
evidence: string[]
key: string
kind: string
severity: string
subject_id: string
suggestion: string
title: string
}[]
windowDays: number
}

export interface DashPortrait {
activities: {
category: string
days: number[]
end: (null | string)
goal: {
[k: string]: unknown
}
key: string
kind: string
label: string
last: (null | {
at: string
done: boolean
summary: string
})
paused: boolean
start: (null | string)
streak: number
text: string
today: string
type: string
week_done: number
}[]
avoid: unknown[]
day: unknown[]
enjoys: {
domain: string
key: string
text: string
}[]
gaps: {
items: {
key: string
known: boolean
}[]
known: number
total: number
}
knownSince: (null | string)
learned: {
at: string
domain: string
id: string
key: string
said: {
[k: string]: unknown
}
source: string
statedBy: string
status: string
text: string
}[]
mood: {
days: {
at: string
day: string
score: number
source: string
summary: string
word: string
}[]
now: (null | {
at: string
score: number
source: string
summary: string
word: string
})
}
people: {
id?: string
key?: string
kind: string
name: string
note?: string
phone?: string
relation: string
}[]
person: {
address: {
[k: string]: unknown
}
age: {
[k: string]: unknown
}
callAs: (null | string)
city: {
[k: string]: unknown
}
language: (null | string)
livesWith: {
[k: string]: unknown
}
mobility: {
[k: string]: unknown
}
name: string
}
stats: {
known: number
learnedWeek: number
pending: number
}
week: {
day: string
doses: {
dose: string
id: string
name: string
status: string
time: string
}[]
}[]
}

export interface DashReport {
adherence: {
byDay: {
day: string
expected: number
missed: number
taken: number
}[]
byMedicine: {
dose: (null | string)
expected: number
missed: number
name: string
taken: number
times: string[]
}[]
expected: number
percent: (number | null)
taken: number
}
alerts: unknown[]
appointments: {
doctor: string
key: string
place: string
purpose: string
questions: string[]
status: string
text: string
upcoming: boolean
when: string
}[]
changes: unknown[]
days: number
from: string
generatedAt: string
mood: {
at: string
text: string
}[]
narrative: string
orders: unknown[]
symptoms: unknown[]
to: string
vitals: {
at: string
kind: string
note: {
[k: string]: unknown
}
redFlag: {
[k: string]: unknown
}
value: string
}[]
}

export interface DashSkills {
skills: unknown[]
store: unknown[]
}

export interface DashSpending {
byKind: Record<string, unknown>
byPerson: Record<string, unknown>
byService: Record<string, unknown>
count: number
items: unknown[]
month: string
total: number
}

export interface DashStock {
medicines: {
asOf: {
[k: string]: unknown
}
daysLeft: {
[k: string]: unknown
}
dose: (null | string)
key: string
low: boolean
name: string
perDay: number
stock: {
[k: string]: unknown
}
}[]
refillWithinDays: number
}

export interface DashWellbeing {
concerns: unknown[]
days: {
day: string
level: string
mood: string[]
symptoms: unknown[]
talked: boolean
}[]
daysTalked: number
lastHeard: (null | string)
recentMood: {
at: string
level: string
text: string
}[]
streak: number
}

export interface DashWork {
items: {
due_at: (null | string)
id: string
kind: string
next_action: string
owner: string
ownerName: string
requested_by: {
[k: string]: unknown
}
source: string
state: string
stuck: (null | string)
subject: string
title: string
updated_at: string
waiting_on: (null | string)
}[]
open: number
stuck: number
}
