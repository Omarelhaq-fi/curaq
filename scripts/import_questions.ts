import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import inquirer from 'inquirer';
import { getGoogleAccessToken, getServiceAccount } from '../src/lib/firebase.server';
import dotenv from 'dotenv';
dotenv.config();

type Option = { text: string; isCorrect: boolean; explanation: string };
type ParsedQuestion = {
  questionText: string;
  code: string;
  year: string;
  options: Option[];
  generalComment: string;
  subject: string;
};

// Parser logic
function parseCategoryFile(filePath: string): ParsedQuestion[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const questions: ParsedQuestion[] = [];
  let currentSubject = 'Uncategorized';
  let curQ: Partial<ParsedQuestion> = {};
  let inQuestionText = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Detect Subject
    if (line.startsWith('-> Subject:')) {
      currentSubject = line.replace('-> Subject:', '').trim();
      continue;
    }

    // Detect Question start
    const qMatch = line.match(/^Question \d+ \[Code: (.*?)\]\s*\(Année: (.*?)\):/);
    if (qMatch) {
      if (curQ.questionText) questions.push(curQ as ParsedQuestion);
      curQ = {
        code: qMatch[1],
        year: qMatch[2],
        subject: currentSubject,
        questionText: '',
        options: [],
        generalComment: ''
      };
      inQuestionText = true;
      continue;
    }

    // Detect options
    const optMatch = line.match(/^[A-E]\.\s+(.*?)( ✅ \(CORRECT\))?( -> Note: (.*))?$/);
    if (optMatch && curQ.options) {
      inQuestionText = false;
      const text = optMatch[1].trim();
      const isCorrect = !!optMatch[2];
      const explanation = optMatch[4] ? optMatch[4].trim() : '';
      curQ.options.push({ text, isCorrect, explanation });
      continue;
    }

    // Detect General Comment
    if (line.startsWith('Explication générale:')) {
      inQuestionText = false;
      if (curQ) curQ.generalComment = line.replace('Explication générale:', '').trim();
      continue;
    }

    // Accumulate question text
    if (inQuestionText && !line.startsWith('-----------------')) {
      curQ.questionText += (curQ.questionText ? '\n' : '') + line;
    }
  }
  
  if (curQ.questionText) questions.push(curQ as ParsedQuestion);
  return questions;
}

// Convert string array to Firestore values
function buildFsFields(obj: any): any {
  const fields: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'string') {
      fields[k] = { stringValue: v };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (typeof v === 'number') {
      fields[k] = { integerValue: String(Math.floor(v)) };
    } else if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        fields[k] = { arrayValue: { values: v.map(str => ({ stringValue: str })) } };
      } else if (typeof v[0] === 'number') {
        fields[k] = { arrayValue: { values: v.map(n => ({ integerValue: String(Math.floor(n)) })) } };
      }
    }
  }
  return fields;
}

async function run() {
  console.log('🚀 OmNote QBank Local Importer');
  
  const qbanksResponse = await fetch(`https://firestore.googleapis.com/v1/projects/${getServiceAccount().project_id}/databases/(default)/documents/qbanks`, {
    headers: { Authorization: `Bearer ${await getGoogleAccessToken()}` }
  });
  
  let qbanks = [];
  if (qbanksResponse.ok) {
    const data = await qbanksResponse.json();
    qbanks = (data.documents || []).map((d: any) => ({
      name: d.fields?.name?.stringValue || '(unnamed)',
      value: d.name.split('/').pop()
    }));
  }

  if (qbanks.length === 0) {
    console.error("❌ No Qbanks found in Firestore! Please create one in Admin dashboard first.");
    return;
  }

  const { targetQbank } = await inquirer.prompt([
    {
      type: 'list',
      name: 'targetQbank',
      message: 'Select the destination QBank:',
      choices: qbanks
    }
  ]);

  const targetDir = path.join(process.cwd(), 'medbridge_categories');
  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Directory ${targetDir} not found.`);
    return;
  }
  
  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.error(`❌ No .txt files found in ${targetDir}`);
    return;
  }

  const { selectedFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedFile',
      message: 'Which category file would you like to parse?',
      choices: files
    }
  ]);

  const filePath = path.join(targetDir, selectedFile);
  console.log(`\n📄 Parsing ${selectedFile}...`);
  const questions = parseCategoryFile(filePath);
  
  if (questions.length === 0) {
    console.log("❌ No valid questions found in this file.");
    return;
  }

  // Get unique subjects
  const subjects = [...new Set(questions.map(q => q.subject))];
  
  const { chosenSubjects } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'chosenSubjects',
      message: `Found ${questions.length} questions across ${subjects.length} subjects.\nWhich subjects do you want to import? (Space to select, Enter to confirm)`,
      choices: subjects.map(s => ({ name: s, value: s, checked: true }))
    }
  ]);

  if (chosenSubjects.length === 0) {
    console.log("No subjects selected. Exiting.");
    return;
  }

  const toImport = questions.filter(q => chosenSubjects.includes(q.subject));
  console.log(`\n⏳ Preparing to import ${toImport.length} questions to QBank [${targetQbank}]...`);

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure you want to upload these to Firestore?'
    }
  ]);

  if (!confirm) {
    console.log("Aborted.");
    return;
  }

  // Upload to Firestore
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();

  console.log(`\n🔍 Fetching existing questions to skip duplicates...`);
  const existingMedbridgeCodes = new Set<string>();
  const existingQuestionTexts = new Set<string>();
  
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    let listUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${targetQbank}/questions?pageSize=1000&mask.fieldPaths=medbridgeCode&mask.fieldPaths=questionText`;
    if (pageToken) listUrl += `&pageToken=${pageToken}`;
    
    try {
      const resp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        if (data.documents) {
          data.documents.forEach((d: any) => {
            const code = d.fields?.medbridgeCode?.stringValue;
            const text = d.fields?.questionText?.stringValue;
            if (code) existingMedbridgeCodes.add(code);
            if (text) existingQuestionTexts.add(text);
          });
        }
        pageToken = data.nextPageToken;
        hasMore = !!pageToken;
      } else {
        hasMore = false;
        console.warn("⚠️ Could not fetch existing questions to check for duplicates.");
      }
    } catch (e) {
      hasMore = false;
      console.warn("⚠️ Error fetching existing questions.", e);
    }
  }

  let uploaded = 0;
  let skipped = 0;
  for (let i = 0; i < toImport.length; i++) {
    const q = toImport[i];
    
    if ((q.code && existingMedbridgeCodes.has(q.code)) || existingQuestionTexts.has(q.questionText)) {
      console.log(`⏭️ Skipping Question ${i+1}: Duplicate detected (Code: ${q.code || 'None'})`);
      skipped++;
      continue;
    }
    
    // Format to schema
    const qId = crypto.randomUUID();
    const correctIndices = q.options.map((o, idx) => o.isCorrect ? idx : -1).filter(idx => idx !== -1);
    
    // Build explanations markdown
    let explanationText = "";
    if (q.generalComment) explanationText += `**General Explication:**\n${q.generalComment}\n\n`;
    
    q.options.forEach((o, idx) => {
      if (o.explanation && o.explanation !== "No commentaire") {
        explanationText += `- **Option ${String.fromCharCode(65 + idx)}**: ${o.explanation}\n`;
      }
    });

    const firestoreDoc = {
      questionText: q.questionText,
      options: q.options.map(o => o.text),
      correctIndices,
      explanation: explanationText.trim() || null,
      subject: q.subject,
      created: Date.now(),
      reported: false,
      year: q.year || null,
      medbridgeCode: q.code || null
    };

    const docPath = `qbanks/${targetQbank}/questions/${qId}`;
    const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${docPath}`;

    try {
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: buildFsFields(firestoreDoc) })
      });
      if (!resp.ok) {
        console.error(`❌ Failed to upload Question ${i+1}: ${resp.statusText}`);
      } else {
        uploaded++;
        if (uploaded % 50 === 0) console.log(`✅ Uploaded ${uploaded}/${toImport.length - skipped} questions...`);
      }
    } catch (e) {
      console.error(`❌ Error on Question ${i+1}:`, e);
    }
  }

  console.log(`\n🎉 DONE! Successfully imported ${uploaded} questions! (Skipped ${skipped} duplicates)`);
}

run().catch(console.error);
