# jobdesk persona walkthroughs

Run: 2026-11-11, by `wrapper/tests/personas.ts`. Each persona ran in its own fresh copy of the repo against live job sources.

## Fresher with no resume (B.Sc. Computer Science, 2026)

- Intake: no resume; onboarding conversation (4 questions).
- Profile written by Claude: yes. Independent check of the profile against what the user gave: 0 unsupported claims.
- Scan (free): linkedin-search ok, 10 found, 4 new; shine-search ok, 20 found, 4 new. Model safety check: 8 checked, 0 flagged.
- Shortlist: 1. Senior Analyst at eClerx / 2. Python Developer at WHITE HORSE MANPOWER CONSULTANCY (P) LTD / 3. Associate at TresVista
- Draft message for "Senior Analyst" (65 words, reading grade 5.3): "Hi, I saw the Junior Python Developer role at eClerx Pune and wanted to reach out. I hold a B.Sc Computer Science from Fergusson College, Pune, and my main hands-on project is a Python Flask web app I built with a classmate to track books for our college library — Flask is one of your listed frameworks. Would you be open to a quick call?"
- Grounding check of the draft: 0 unsupported claims.
- Kit for "Senior Analyst" (free): 1 saved answers, all taken from the profile; site policy: LinkedIn (assist).

## Non-tech professional: staff nurse with a Word resume

- Intake: Word resume read without Claude (330 characters).
- Profile written by Claude: yes. Independent check of the profile against what the user gave: 0 unsupported claims.
- Scan (free): linkedin-search ok, 10 found, 4 new; shine-search ok, 20 found, 4 new. Model safety check: 8 checked, 1 flagged.
- Shortlist: 1. Staff Nurse at Nextenti Tech Private Limited / 2. Associate staff nurse at Nextenti Tech Private Limited / 3. STAFF NURSE FEMAL at ABM HOSPITAL
- Draft message for "Staff Nurse" (67 words, reading grade 6.6): "Hi, I came across the Staff Nurse opening at Nextenti Tech for Wards and ICU in Gachibowli. I hold a B.Sc Nursing from Gandhi Medical College (2019) and have been working as a Staff Nurse at Care Hospitals, Hyderabad since 2020, with hands-on ICU care including ventilator management for 8–10 patients per shift. Would you be open to a quick call to discuss the role? Lakshmi Devi"
- Grounding check of the draft: 0 unsupported claims.
- Kit for "Staff Nurse" (free): 2 saved answers, all taken from the profile; site policy: LinkedIn (assist).

## Regional-language user: warehouse supervisor who chats in Hindi

- Intake: resume text.
- Profile written by Claude: yes. Independent check of the profile against what the user gave: 0 unsupported claims.
- Scan (free): linkedin-search ok, 10 found, 4 new; shine-search ok, 20 found, 4 new. Model safety check: 8 checked, 0 flagged.
- Shortlist: 1. Team Lead-Lucknow at Blitz / 2. Operations Executive: LTS at Blue Dart / 3. Logistics Supervisor Jobs in Jyoti Enterprise - Lucknow, Uttar Pradesh at VIHU
- Draft message for "Team Lead-Lucknow" (53 words, reading grade 5.1): "Hi, Blitz's focus on same-day delivery for eCommerce brands caught my eye. At Flipkart's fulfilment centre in Lucknow, I supervised a team of 12 pickers with a daily dispatch of 3,000 orders. I'm based in Lucknow and interested in the Team Lead role. Would you have time for a brief call? Ramesh Yadav"
- Grounding check of the draft: 0 unsupported claims.
- Kit for "Team Lead-Lucknow" (free): 2 saved answers, all taken from the profile; site policy: LinkedIn (assist).
- Hindi question to the bot -> reply in Hindi (171 Devanagari characters): "आपके लिए **8 नई नौकरियाँ** मिली हैं। ये सभी लगभग कम फिट हैं - जैसे Team Lead, Warehouse Manager, Logistics Supervisor की positions।   **आगे क्या करें:** 1. `/ra..."

## Budget-capped user ($0 a month for AI)

- Intake: resume text.
- Profile: free path (`jobdesk intake --to-profile`): resume copied into the profile word for word, no AI used.
- Scan (free): linkedin-search ok, 10 found, 4 new; shine-search ok, 20 found, 4 new. Model safety check: skipped (Monthly budget reached ($0). Running free features only.).
- Shortlist: 1. Senior Accountant at GDCI India Private Limited / 2. Financial Accountant at AtkinsRéalis / 3. Senior Accountant [F/M/D] at EagleBurgmann
- Draft: not written - Monthly budget reached ($0). Running free features only.
- Kit for "Senior Accountant" (free): 0 saved answers, all taken from the profile; site policy: LinkedIn (assist).

## Screen-reader user (keyboard only)

- Intake: resume text.
- Profile written by Claude: yes. Independent check of the profile against what the user gave: 0 unsupported claims.
- Scan (free): linkedin-search ok, 10 found, 4 new; shine-search ok, 20 found, 4 new. Model safety check: 8 checked, 0 flagged.
- Shortlist: 1. CUSTOMER SUPPORT - BANKING at PERSONAL NETWORK. / 2. CUSTOMER SUPPORT (HEBREW LANG) at PERSONAL NETWORK. / 3. Customer Support at The Job Factory
- Draft message for "CUSTOMER SUPPORT - BANKING" (61 words, reading grade 6.0): "Hi Raj, I came across your opening for Customer Support in Banking and Payments at Whitefield. I spent four years as a Customer Support Associate at Swiggy, handling chat and email support and consistently maintaining a 95% CSAT. I hold a B.A. in English from Mount Carmel College, Bengaluru. Would you be open to a quick call to discuss the role?"
- Grounding check of the draft: 0 unsupported claims.
- Kit for "CUSTOMER SUPPORT - BANKING" (free): 2 saved answers, all taken from the profile; site policy: Shine (assist).
- Accessibility suite (axe-core WCAG 2.2 AA, light and dark, keyboard tab order): passed

Total Claude cost for the run: $2.20.
