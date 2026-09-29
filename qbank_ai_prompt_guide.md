# 🤖 QBank Question Generation: AI Prompt Guide

When asking AI models (like Gemini, ChatGPT, Claude) to generate new medical questions, you need them to output exactly the same format so the importer can read it perfectly.

Copy and paste the following prompt to any AI model:

***

### Copy-Paste this Prompt to the AI:

```text
You are an expert medical professor creating high-yield Multiple Choice Questions (MCQs) for a medical QBank. 

Generate [NUMBER] clinical questions about [TOPIC/SUBCATEGORY]. 
You MUST format your response EXACTLY following this strict text structure. Do not use markdown tables or JSON. Use plain text exactly as shown below.

STRICT FORMAT RULES:
1. Start each subcategory with: `  -> Subject: [Name of Subject]`
2. Start each chapter (sub-subcategory) with: `  -> Chapter: [Name of Chapter]`
3. Start each question with: `Question [Number] [Code: random_5_chars] (Année: [Year]):`
4. Write the question text on the next line.
5. List options A to E. 
6. For the correct option(s), append exactly ` ✅ (CORRECT)` immediately after the option text.
7. For every option (both correct and incorrect), append an explanation arrow exactly formatted as: ` -> Note: [Explanation for this specific option]`
8. Add a general explanation at the end starting exactly with: `Explication générale: [Overall explanation and clinical pearls]`
9. Add a separator exactly as: `--------------------------------------------------`

EXAMPLE OF THE EXACT REQUIRED FORMAT:

  -> Subject: Cardiologie - Douleurs Thoraciques
  -> Chapter: Urgences Cardiologiques
Question 1 [Code: a1b2c] (Année: 2024):
Un patient de 60 ans présente une douleur thoracique typique... Quel est le diagnostic le plus probable ?
  A. Péricardite aiguë -> Note: La douleur de la péricardite est soulagée par l'antéflexion, ce qui n'est pas le cas ici.
  B. Syndrome coronarien aigu ✅ (CORRECT) -> Note: Douleur rétrosternale constrictive irradiant vers le bras gauche, typique du SCA.
  C. Dissection aortique -> Note: La douleur serait migratrice et asymétrie tensionnelle présente.
  D. Embolie pulmonaire -> Note: L'ECG ne montre pas de signes droits (S1Q3).
  E. Pneumothorax -> Note: L'auscultation pulmonaire est normale.
Explication générale: Leçon clé: Le SCA doit toujours être suspecté en premier devant une douleur thoracique constrictive chez un patient à risque. Piège à éviter: Ne pas attendre la troponine pour faire un ECG.

--------------------------------------------------
```
