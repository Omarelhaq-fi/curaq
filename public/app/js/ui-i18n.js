// OmNote UI i18n — translates the whole interface (menus, buttons, labels).
// Uses the unified site language from i18n.js. Default: English.
(function () {
    // Use the LS key that matches i18n.js unified language
    const LS_KEY = 'omnote_site_language';

    // Dictionary: English source -> { ar, fr }.
    const DICT = {
        // Auth / login
        "Sign in to access your cloud workspace.": { ar: "سجّل الدخول للوصول إلى مساحة العمل السحابية.", fr: "Connectez-vous pour accéder à votre espace de travail cloud." },
        "Email Address": { ar: "البريد الإلكتروني", fr: "Adresse e-mail" },
        "Password": { ar: "كلمة المرور", fr: "Mot de passe" },
        "Log In": { ar: "تسجيل الدخول", fr: "Se connecter" },
        "Create Account": { ar: "إنشاء حساب", fr: "Créer un compte" },
        "Log Out": { ar: "تسجيل الخروج", fr: "Se déconnecter" },

        // Sidebar / navigation
        "Home": { ar: "الرئيسية", fr: "Accueil" },
        "Browse Specialties": { ar: "تصفح التخصصات", fr: "Parcourir les spécialités" },
        "Exam Prep": { ar: "التحضير للامتحان", fr: "Préparation à l'examen" },
        "Incorrect": { ar: "الخاطئ", fr: "Incorrect" },
        "Marked": { ar: "المُعلَّم", fr: "Marqué" },
        "Flashcards": { ar: "البطاقات", fr: "Cartes mémoire" },
        "Study Planner": { ar: "مخطط الدراسة", fr: "Planificateur d'études" },
        "Study Resources": { ar: "مصادر الدراسة", fr: "Ressources d'étude" },
        "Performance": { ar: "الأداء", fr: "Performance" },
        "Answer Parties": { ar: "حفلات الإجابات", fr: "Sessions de groupe" },
        "Become a Supporter": { ar: "ادعم التطبيق", fr: "Devenir supporter" },
        "Admin Panel": { ar: "لوحة الإدارة", fr: "Panneau d'administration" },

        // Topbar
        "Search subjects, chapters, or question ID...": { ar: "ابحث في التخصصات أو الفصول أو رقم السؤال...", fr: "Rechercher spécialités, chapitres ou ID de question..." },
        "Search...": { ar: "بحث...", fr: "Rechercher..." },
        "Change QBank": { ar: "تغيير بنك الأسئلة", fr: "Changer de banque" },
        "All Banks": { ar: "جميع البنوك", fr: "Toutes les banques" },

        // Main nav tabs
        "Study Plan": { ar: "خطة الدراسة", fr: "Plan d'étude" },
        "Summary": { ar: "الملخص", fr: "Résumé" },
        "AI Tutor": { ar: "المعلم الذكي", fr: "Tuteur IA" },

        // Home
        "Your workspace": { ar: "مساحة عملك", fr: "Votre espace" },
        "Welcome back.": { ar: "مرحبًا بعودتك.", fr: "Bon retour." },
        "Ready to master something new today?": { ar: "مستعد لإتقان شيء جديد اليوم؟", fr: "Prêt à maîtriser quelque chose de nouveau aujourd'hui ?" },
        "New Document": { ar: "مستند جديد", fr: "Nouveau document" },
        "Upload PDF": { ar: "رفع PDF", fr: "Téléverser un PDF" },
        "Import CSV": { ar: "استيراد CSV", fr: "Importer CSV" },
        "Let's get started": { ar: "لنبدأ", fr: "C'est parti" },
        "Upload your first PDF to generate summaries, flashcards, and study plans instantly.": { ar: "ارفع أول ملف PDF لإنشاء ملخصات وبطاقات وخطط دراسية على الفور.", fr: "Téléversez votre premier PDF pour générer résumés, cartes et plans d'étude en un instant." },
        "Upload your first PDF": { ar: "ارفع أول ملف PDF", fr: "Téléversez votre premier PDF" },
        "Replay the quick tour": { ar: "إعادة عرض الجولة السريعة", fr: "Revoir la visite rapide" },

        // Dashboard
        "Ready to Practice": { ar: "مستعد للتدريب", fr: "Pratiquer" },
        "Start a new block to build mastery.": { ar: "ابدأ كتلة جديدة لبناء الإتقان.", fr: "Commencez un nouveau bloc pour progresser." },
        "Start Session": { ar: "ابدأ الجلسة", fr: "Commencer" },
        "Performance Overview": { ar: "نظرة عامة على الأداء", fr: "Aperçu des performances" },
        "TOTAL QUESTIONS": { ar: "إجمالي الأسئلة", fr: "TOTAL DES QUESTIONS" },
        "Global Accuracy": { ar: "الدقة الإجمالية", fr: "Précision globale" },
        "Correct:": { ar: "صحيح:", fr: "Correct:" },
        "Incorrect:": { ar: "خاطئ:", fr: "Incorrect:" },
        "Unused:": { ar: "غير مستخدم:", fr: "Inutilisé:" },
        "Questions Used": { ar: "الأسئلة المستخدمة", fr: "Questions utilisées" },
        "Study Streak": { ar: "سلسلة الدراسة", fr: "Série d'études" },
        "days": { ar: "أيام", fr: "jours" },
        "Weaker Areas": { ar: "نقاط الضعف", fr: "Points faibles" },
        "Needs practice": { ar: "يحتاج تدريب", fr: "Besoin de pratique" },
        "Recent Activity": { ar: "النشاط الأخير", fr: "Activité récente" },
        "No recent sessions yet. Start practicing!": { ar: "لا توجد جلسات حديثة. ابدأ التدريب!", fr: "Pas encore de sessions récentes. Commencez à pratiquer!" },
        "Quick Launch": { ar: "بدء سريع", fr: "Lancement rapide" },

        // QBank
        "Select Your Question Bank": { ar: "اختر بنك الأسئلة", fr: "Sélectionnez votre banque de questions" },
        "Choose the bank you want to practice.": { ar: "اختر البنك الذي تريد التدريب عليه.", fr: "Choisissez la banque sur laquelle vous voulez vous entraîner." },
        "Select Bank": { ar: "اختر البنك", fr: "Sélectionner" },
        "Select Sub-Category": { ar: "اختر التصنيف الفرعي", fr: "Sélectionner une sous-catégorie" },
        "All Subjects (Mix)": { ar: "جميع التخصصات (مزيج)", fr: "Toutes spécialités (Mix)" },
        "Practice questions from all available subjects": { ar: "تدرب على أسئلة من جميع التخصصات المتاحة", fr: "Questions de toutes les spécialités disponibles" },
        "View Chapters": { ar: "عرض الفصول", fr: "Voir les chapitres" },
        "Answered": { ar: "تم الإجابة", fr: "Répondu" },
        "Score": { ar: "النتيجة", fr: "Score" },
        "Search sub-categories...": { ar: "بحث في التصنيفات الفرعية...", fr: "Rechercher des sous-catégories..." },
        "Search chapters...": { ar: "بحث في الفصول...", fr: "Rechercher des chapitres..." },
        "All Chapters (Mix)": { ar: "جميع الفصول (مزيج)", fr: "Tous les chapitres (Mix)" },
        "Practice questions from all chapters in this subject": { ar: "تدرب على أسئلة من جميع الفصول في هذا التخصص", fr: "Questions de tous les chapitres de cette spécialité" },
        "Back to Subjects": { ar: "العودة للتخصصات", fr: "Retour aux spécialités" },
        "Start Subject": { ar: "ابدأ التخصص", fr: "Commencer la spécialité" },
        "Back": { ar: "رجوع", fr: "Retour" },
        "Start Practicing": { ar: "ابدأ التدريب", fr: "Commencer à pratiquer" },

        // QBank home dashboard
        "Good morning": { ar: "صباح الخير", fr: "Bonjour" },
        "Good afternoon": { ar: "طاب مساؤك", fr: "Bon après-midi" },
        "Good evening": { ar: "مساء الخير", fr: "Bonsoir" },
        "Doctor": { ar: "دكتور", fr: "Docteur" },
        "Search a topic, jump into a block, or continue where you left off.": { ar: "ابحث عن موضوع، أو انتقل إلى كتلة، أو تابع من حيث توقفت.", fr: "Recherchez un sujet, lancez un bloc ou reprenez où vous en étiez." },
        "Study streak": { ar: "سلسلة الدراسة", fr: "Série d'étude" },
        "day streak": { ar: "يوم متتالي", fr: "jour d'affilée" },
        "days streak": { ar: "أيام متتالية", fr: "jours d'affilée" },
        "Search your banks": { ar: "ابحث في بنوكك", fr: "Recherchez dans vos banques" },
        "Find what you need, fast": { ar: "اعثر على ما تحتاجه بسرعة", fr: "Trouvez ce qu'il vous faut, vite" },
        "Search subjects, chapters, parts and tags across your accessible banks.": { ar: "ابحث في التخصصات والفصول والأجزاء والوسوم ضمن البنوك المتاحة لك.", fr: "Recherchez des spécialités, chapitres, parties et tags dans vos banques accessibles." },
        "Search subjects, chapters, parts and tags": { ar: "ابحث في التخصصات والفصول والأجزاء والوسوم", fr: "Rechercher des spécialités, chapitres, parties et tags" },
        "Search subjects, chapters, parts, tags...": { ar: "ابحث في التخصصات والفصول والأجزاء والوسوم...", fr: "Rechercher spécialités, chapitres, parties, tags..." },
        "Search suggestions": { ar: "اقتراحات البحث", fr: "Suggestions de recherche" },
        "Quick searches": { ar: "عمليات بحث سريعة", fr: "Recherches rapides" },
        "Quick search": { ar: "بحث سريع", fr: "Recherche rapide" },
        "Quick actions": { ar: "إجراءات سريعة", fr: "Actions rapides" },
        "Start answering or build a timed block.": { ar: "ابدأ بالإجابة أو أنشئ كتلة موقوتة.", fr: "Commencez à répondre ou créez un bloc chronométré." },
        "Practice questions": { ar: "تدرّب على الأسئلة", fr: "Questions d'entraînement" },
        "Browse subjects and chapters": { ar: "تصفح التخصصات والفصول", fr: "Parcourir les spécialités et chapitres" },
        "Build a block": { ar: "أنشئ كتلة", fr: "Créer un bloc" },
        "40 questions · 60 minutes": { ar: "40 سؤالاً · 60 دقيقة", fr: "40 questions · 60 minutes" },
        "Review incorrects": { ar: "راجع الأخطاء", fr: "Revoir les erreurs" },
        "to revisit": { ar: "للمراجعة", fr: "à revoir" },
        "No incorrect answers yet": { ar: "لا توجد إجابات خاطئة بعد", fr: "Aucune réponse incorrecte pour l'instant" },
        "Past papers": { ar: "الامتحانات السابقة", fr: "Annales" },
        "No past papers yet": { ar: "لا توجد امتحانات سابقة بعد", fr: "Pas encore d'annales" },
        "exam available": { ar: "امتحان متاح", fr: "examen disponible" },
        "exams available": { ar: "امتحانات متاحة", fr: "examens disponibles" },
        "Continue your last session": { ar: "تابع جلستك الأخيرة", fr: "Continuez votre dernière session" },
        "Pick up where you left off": { ar: "تابع من حيث توقفت", fr: "Reprenez où vous en étiez" },
        "Mixed practice": { ar: "تدريب مختلط", fr: "Pratique mixte" },
        "answered": { ar: "مُجابة", fr: "répondues" },
        "Resume": { ar: "استئناف", fr: "Reprendre" },
        "Choose how you want to study": { ar: "اختر كيف تريد الدراسة", fr: "Choisissez votre méthode d'étude" },
        "Regular QBank": { ar: "بنك الأسئلة العادي", fr: "Banque de questions" },
        "Practice by subject": { ar: "التدرّب حسب التخصص", fr: "Pratiquer par spécialité" },
        "Choose a subject or mix everything. Best for daily studying and building your base.": { ar: "اختر تخصصًا أو امزج كل شيء. الأنسب للدراسة اليومية وبناء أساسك.", fr: "Choisissez une spécialité ou mélangez tout. Idéal pour l'étude quotidienne et consolider vos bases." },
        "subjects": { ar: "تخصصات", fr: "spécialités" },
        "subject": { ar: "تخصص", fr: "spécialité" },
        "questions": { ar: "أسئلة", fr: "questions" },
        "average": { ar: "متوسط", fr: "moyenne" },
        "Bank progress": { ar: "تقدم البنك", fr: "Progression de la banque" },
        "Start practicing": { ar: "ابدأ التدريب", fr: "Commencer à pratiquer" },
        "Change bank": { ar: "تغيير البنك", fr: "Changer de banque" },
        "Exam prep": { ar: "التحضير للامتحان", fr: "Préparation à l'examen" },
        "Past exams by college": { ar: "الامتحانات السابقة حسب الكلية", fr: "Annales par faculté" },
        "Past papers will appear here as soon as your college adds them.": { ar: "ستظهر الامتحانات السابقة هنا بمجرد أن تضيفها كليتك.", fr: "Les annales apparaîtront ici dès que votre faculté les ajoutera." },
        "Your college is saved. Open your past papers in one tap.": { ar: "كليتك محفوظة. افتح امتحاناتك السابقة بنقرة واحدة.", fr: "Votre faculté est enregistrée. Ouvrez vos annales en un clic." },
        "Practise the exact style of exam your college sets. Choose your college once.": { ar: "تدرّب على نمط الامتحان الذي تعتمده كليتك. اختر كليتك مرة واحدة.", fr: "Entraînez-vous au style exact d'examen de votre faculté. Choisissez-la une fois." },
        "Your college": { ar: "كليتك", fr: "Votre faculté" },
        "past exam": { ar: "امتحان سابق", fr: "examen précédent" },
        "past exams": { ar: "امتحانات سابقة", fr: "examens précédents" },
        "Change": { ar: "تغيير", fr: "Changer" },
        "Choose your college": { ar: "اختر كليتك", fr: "Choisissez votre faculté" },
        "One-time setup · change anytime": { ar: "إعداد لمرة واحدة · غيّره في أي وقت", fr: "Configuration unique · modifiable à tout moment" },
        "Open exam prep": { ar: "افتح التحضير للامتحان", fr: "Ouvrir la préparation d'examen" },
        "Open my college exams": { ar: "افتح امتحانات كليتي", fr: "Ouvrir les examens de ma faculté" },
        "Choose my college": { ar: "اختر كليتي", fr: "Choisir ma faculté" },
        "See all colleges": { ar: "عرض جميع الكليات", fr: "Voir toutes les facultés" },
        "Your overall progress": { ar: "تقدمك الإجمالي", fr: "Votre progression globale" },
        "questions answered": { ar: "أسئلة تمت الإجابة عنها", fr: "questions répondues" },
        "average score": { ar: "متوسط النتيجة", fr: "score moyen" },
        "questions to review": { ar: "أسئلة للمراجعة", fr: "questions à revoir" },
        "country of past exams available": { ar: "دولة لديها امتحانات سابقة متاحة", fr: "pays avec annales disponibles" },
        "countries of past exams available": { ar: "دول لديها امتحانات سابقة متاحة", fr: "pays avec annales disponibles" },
        "Past exams will appear when your college adds them": { ar: "ستظهر الامتحانات السابقة عندما تضيفها كليتك", fr: "Les annales apparaîtront lorsque votre faculté les ajoutera" },
        "You can change your college anytime.": { ar: "يمكنك تغيير كليتك في أي وقت.", fr: "Vous pouvez changer de faculté à tout moment." },
        "Choose your country": { ar: "اختر بلدك", fr: "Choisissez votre pays" },
        "Then pick your college. We will remember it for next time.": { ar: "ثم اختر كليتك. سنتذكرها في المرة القادمة.", fr: "Puis choisissez votre faculté. Nous la mémoriserons pour la prochaine fois." },
        "Close college picker": { ar: "إغلاق اختيار الكلية", fr: "Fermer le sélecteur de faculté" },
        "college": { ar: "كلية", fr: "faculté" },
        "colleges": { ar: "كليات", fr: "facultés" },
        "exam": { ar: "امتحان", fr: "examen" },
        "exams": { ar: "امتحانات", fr: "examens" },
        "No past exams have been added yet. Check back soon.": { ar: "لم تتم إضافة امتحانات سابقة بعد. تحقق لاحقًا.", fr: "Aucune annale n'a encore été ajoutée. Revenez bientôt." },
        "No past exams in this country yet. Please check back soon.": { ar: "لا توجد امتحانات سابقة في هذا البلد بعد. يرجى التحقق لاحقًا.", fr: "Pas encore d'annales dans ce pays. Revenez bientôt." },
        "All countries": { ar: "جميع الدول", fr: "Tous les pays" },
        "Pick once. We will open this college's past exams for you.": { ar: "اختر مرة واحدة. سنفتح لك الامتحانات السابقة لهذه الكلية.", fr: "Choisissez une fois. Nous ouvrirons les annales de cette faculté pour vous." },
        "USA": { ar: "الولايات المتحدة", fr: "États-Unis" },
        "UK": { ar: "المملكة المتحدة", fr: "Royaume-Uni" },
        "Australia": { ar: "أستراليا", fr: "Australie" },
        "Canada": { ar: "كندا", fr: "Canada" },
        "India": { ar: "الهند", fr: "Inde" },
        "Europe": { ar: "أوروبا", fr: "Europe" },
        "Tunisia": { ar: "تونس", fr: "Tunisie" },
        "Algeria": { ar: "الجزائر", fr: "Algérie" },
        "Egypt": { ar: "مصر", fr: "Égypte" },
        "Morocco": { ar: "المغرب", fr: "Maroc" },
        "Saudi Arabia": { ar: "السعودية", fr: "Arabie saoudite" },
        "International": { ar: "دولي", fr: "International" },
        "General": { ar: "عام", fr: "Général" },

        // Question interface
        "Continue": { ar: "متابعة", fr: "Continuer" },
        "Leave": { ar: "مغادرة", fr: "Quitter" },
        "Show Answer": { ar: "إظهار الإجابة", fr: "Afficher la réponse" },
        "Submit Answer": { ar: "إرسال الإجابة", fr: "Soumettre" },
        "Next": { ar: "التالي", fr: "Suivant" },
        "Previous": { ar: "السابق", fr: "Précédent" },
        "End Block": { ar: "إنهاء الكتلة", fr: "Terminer le bloc" },
        "Time:": { ar: "الوقت:", fr: "Temps:" },
        "Question": { ar: "السؤال", fr: "Question" },
        "of": { ar: "من", fr: "sur" },
        "Marked": { ar: "مُعلَّم", fr: "Marqué" },
        "Mark": { ar: "تعليم", fr: "Marquer" },
        "Add Note": { ar: "إضافة ملاحظة", fr: "Ajouter note" },
        "AI Flashcard": { ar: "بطاقة ذكية", fr: "Carte IA" },

        // Review
        "Review": { ar: "مراجعة", fr: "Révision" },
        "Due today": { ar: "مستحق اليوم", fr: "Du jour" },
        "cards": { ar: "بطاقات", fr: "cartes" },
        "Streak": { ar: "سلسلة", fr: "Série" },
        "This week": { ar: "هذا الأسبوع", fr: "Cette semaine" },
        "Mastered": { ar: "مُتقن", fr: "Maîtrisé" },
        "Start New Block": { ar: "ابدأ كتلة جديدة", fr: "Nouveau bloc" },

        // Scheduler
        "Plan & track": { ar: "خطط وتتبّع", fr: "Planifier et suivre" },
        "Scheduler": { ar: "المخطط", fr: "Planificateur" },
        "Plan your study sessions and keep every exam on your radar.": { ar: "خطّط لجلسات الدراسة وابقَ متابعًا لكل امتحان.", fr: "Planifiez vos sessions et gardez chaque examen à l'œil." },
        "Add Study": { ar: "إضافة دراسة", fr: "Ajouter étude" },
        "Add Exam": { ar: "إضافة امتحان", fr: "Ajouter examen" },
        "Today": { ar: "اليوم", fr: "Aujourd'hui" },
        "Study": { ar: "دراسة", fr: "Étude" },
        "Exam": { ar: "امتحان", fr: "Examen" },
        "Select a day": { ar: "اختر يومًا", fr: "Choisir un jour" },
        "Upcoming (next 7 days)": { ar: "القادم (خلال 7 أيام)", fr: "À venir (7 jours)" },
        "Nothing scheduled yet.": { ar: "لا يوجد شيء مجدول بعد.", fr: "Rien de programmé pour le moment." },
        "＋ Add Item": { ar: "＋ إضافة عنصر", fr: "＋ Ajouter un élément" },
        "Type": { ar: "النوع", fr: "Type" },
        "Title": { ar: "العنوان", fr: "Titre" },
        "Date": { ar: "التاريخ", fr: "Date" },
        "Time": { ar: "الوقت", fr: "Heure" },
        "Duration (min)": { ar: "المدة (دقيقة)", fr: "Durée (min)" },
        "Linked document (optional)": { ar: "مستند مرتبط (اختياري)", fr: "Document lié (facultatif)" },
        "Notes (optional)": { ar: "ملاحظات (اختياري)", fr: "Notes (facultatif)" },
        "Delete": { ar: "حذف", fr: "Supprimer" },
        "Cancel": { ar: "إلغاء", fr: "Annuler" },
        "Save": { ar: "حفظ", fr: "Enregistrer" },
        "Save Changes": { ar: "حفظ التغييرات", fr: "Enregistrer" },

        // Left pane tabs
        "Read PDF": { ar: "قراءة PDF", fr: "Lire le PDF" },
        "Read Summary": { ar: "قراءة الملخص", fr: "Lire le résumé" },
        "Notes": { ar: "الملاحظات", fr: "Notes" },
        "🃏 Flashcards": { ar: "🃏 البطاقات", fr: "🃏 Cartes" },
        "No PDF Uploaded": { ar: "لم يتم رفع أي PDF", fr: "Aucun PDF téléversé" },
        "Browse PDF Locally": { ar: "استعراض PDF محليًا", fr: "Parcourir un PDF local" },
        "Detailed": { ar: "مفصّل", fr: "Détaillé" },
        "Upload a PDF to generate a beautiful summary.": { ar: "ارفع ملف PDF لإنشاء ملخص جميل.", fr: "Téléversez un PDF pour générer un beau résumé." },
        "▶ Review": { ar: "▶ مراجعة", fr: "▶ Réviser" },
        "＋ Add Flashcard": { ar: "＋ إضافة بطاقة", fr: "＋ Ajouter carte" },
        "Front (Question)": { ar: "الوجه (السؤال)", fr: "Recto (Question)" },
        "Back (Answer)": { ar: "الخلف (الإجابة)", fr: "Verso (Réponse)" },

        // Right pane
        "AI Tutor": { ar: "المعلم الذكي", fr: "Tuteur IA" },
        "Upload a PDF to generate a study plan.": { ar: "ارفع ملف PDF لإنشاء خطة دراسة.", fr: "Téléversez un PDF pour générer un plan d'étude." },
        "Upload a PDF and I can answer questions about it!": { ar: "ارفع ملف PDF ويمكنني الإجابة عن أسئلتك حوله!", fr: "Téléversez un PDF et je pourrai répondre à vos questions." },
        "Ask a question...": { ar: "اطرح سؤالاً...", fr: "Posez une question..." },
        "Send Message": { ar: "إرسال", fr: "Envoyer" },

        // Profile settings
        "Profile Settings": { ar: "إعدادات الملف الشخصي", fr: "Paramètres du profil" },
        "Display Name": { ar: "اسم العرض", fr: "Nom d'affichage" },
        "Shown across the app and on your profile.": { ar: "يظهر في جميع أنحاء التطبيق وفي ملفك الشخصي.", fr: "Affiché dans toute l'application et sur votre profil." },
        "Custom Avatar": { ar: "صورة رمزية مخصصة", fr: "Avatar personnalisé" },
        "Upload a square image to be used as your avatar.": { ar: "ارفع صورة مربعة لاستخدامها كصورة رمزية.", fr: "Téléversez une image carrée pour votre avatar." },
        "Upload Image": { ar: "رفع صورة", fr: "Téléverser" },
        "Remove": { ar: "إزالة", fr: "Supprimer" },
        "Site Language": { ar: "لغة الموقع", fr: "Langue du site" },
        "Translates buttons, menus, labels, and AI content across the app.": { ar: "يترجم الأزرار والقوائم والتسميات ومحتوى الذكاء الاصطناعي.", fr: "Traduit les boutons, menus, libellés et contenu IA dans l'application." },
        "Account": { ar: "الحساب", fr: "Compte" },
        "Verify your email to unlock AI features.": { ar: "تحقق من بريدك لفتح ميزات الذكاء الاصطناعي.", fr: "Vérifiez votre email pour débloquer les fonctionnalités IA." },
        "Your email is verified.": { ar: "تم التحقق من بريدك.", fr: "Votre email est vérifié." },
        "Your email is not verified. Verify to unlock AI features.": { ar: "لم يتم التحقق من بريدك. تحقق لفتح ميزات الذكاء الاصطناعي.", fr: "Votre email n'est pas vérifié. Vérifiez pour débloquer les fonctionnalités IA." },
        "Resend verification email": { ar: "إعادة إرسال بريد التحقق", fr: "Renvoyer l'email de vérification" },
        "Sending...": { ar: "جارٍ الإرسال...", fr: "Envoi..." },
        "Sent — check your inbox": { ar: "تم الإرسال — تحقق من صندوق الوارد", fr: "Envoyé — vérifiez votre boîte de réception" },
        "Close": { ar: "إغلاق", fr: "Fermer" },

        // Welcome onboarding
        "Welcome to CuraQ": { ar: "مرحبًا بك في CuraQ", fr: "Bienvenue sur CuraQ" },
        "Let's personalize your workspace. Your country decides which question banks you get.": { ar: "لنخصص مساحة عملك. بلدك تحدد بنوك الأسئلة التي تحصل عليها.", fr: "Personnalisons votre espace. Votre pays détermine les banques de questions accessibles." },
        "Your full name": { ar: "اسمك الكامل", fr: "Votre nom complet" },
        "e.g. Ahmed Hassan": { ar: "مثال: أحمد حسن", fr: "ex: Ahmed Hassan" },
        "Select your country": { ar: "اختر بلدك", fr: "Sélectionnez votre pays" },
        "Start studying": { ar: "ابدأ الدراسة", fr: "Commencer à étudier" },
        "Setting up…": { ar: "جارٍ الإعداد...", fr: "Configuration..." },
        "Please enter your name.": { ar: "يرجى إدخال اسمك.", fr: "Veuillez entrer votre nom." },
        "Please select your country.": { ar: "يرجى اختيار بلدك.", fr: "Veuillez sélectionner votre pays." },

        // Misc
        "Continue Session": { ar: "متابعة الجلسة", fr: "Continuer la session" },
        "All Subjects": { ar: "جميع التخصصات", fr: "Toutes spécialités" },
        "Chapters:": { ar: "الفصول:", fr: "Chapitres:" },
        "Unknown": { ar: "غير معروف", fr: "Inconnu" },
        "Uncategorized": { ar: "غير مصنف", fr: "Non classé" },
    };

    const RTL = { ar: true };

    function getUiLang() {
        try {
            const v = localStorage.getItem(LS_KEY);
            if (v && (v === 'en' || DICT["Save"][v])) return v;
        } catch (e) {}
        return 'en';
    }
    window.getUiLanguage = getUiLang;

    window.setUiLanguage = function (lang) {
        if (lang !== 'en' && !DICT["Save"][lang]) return;
        try { localStorage.setItem(LS_KEY, lang); } catch (e) {}
        try {
            if (window.db) {
                if (!window.db.settings) window.db.settings = {};
                window.db.settings.siteLanguage = lang;
                if (typeof saveDb === 'function') saveDb();
            }
        } catch (e) {}
        // Reload for a clean re-render of every dynamic string.
        location.reload();
    };

    function translateString(s) {
        const lang = getUiLang();
        if (lang === 'en') return null;
        const key = s.trim();
        if (!key) return null;
        const entry = DICT[key];
        if (!entry) return null;
        const translated = entry[lang];
        if (!translated) return null;
        // Preserve surrounding whitespace so layout stays intact.
        const leading = s.match(/^\s*/)[0];
        const trailing = s.match(/\s*$/)[0];
        return leading + translated + trailing;
    }

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
    // Elements whose subtree we never touch (AI/user content, PDF text layer, editors).
    const SKIP_SELECTORS = [
        '#editor-container', '.markdown-body', '.textLayer',
        '#chat-messages', '#doc-explain-modal-content', '#summary-content',
        '.usmle-question-text', '.usmle-answer-reveal',
        '[data-no-i18n]', '[contenteditable="true"]',
    ];


    function shouldSkip(node) {
        let el = node.nodeType === 1 ? node : node.parentElement;
        while (el) {
            if (SKIP_TAGS.has(el.tagName)) return true;
            for (const sel of SKIP_SELECTORS) {
                if (el.matches && el.matches(sel)) return true;
            }
            el = el.parentElement;
        }
        return false;
    }

    function translateAttrs(el) {
        ['placeholder', 'title', 'aria-label'].forEach(attr => {
            const v = el.getAttribute && el.getAttribute(attr);
            if (!v) return;
            const t = translateString(v);
            if (t !== null && t !== v) el.setAttribute(attr, t);
        });
    }

    function translateTree(root) {
        if (!root) return;
        if (root.nodeType === 3) {
            if (shouldSkip(root)) return;
            const t = translateString(root.nodeValue);
            if (t !== null && t !== root.nodeValue) root.nodeValue = t;
            return;
        }
        if (root.nodeType !== 1) return;
        if (shouldSkip(root)) return;
        translateAttrs(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
            acceptNode: (n) => shouldSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeType === 3) {
                const t = translateString(n.nodeValue);
                if (t !== null && t !== n.nodeValue) n.nodeValue = t;
            } else if (n.nodeType === 1) {
                translateAttrs(n);
            }
        }
    }

    let pending = new Set();
    let scheduled = false;
    function schedule(node) {
        pending.add(node);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            const nodes = Array.from(pending);
            pending.clear();
            scheduled = false;
            nodes.forEach(translateTree);
        });
    }

    function startObserver() {
        const obs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes.forEach(n => schedule(n));
                if (m.type === 'characterData') schedule(m.target);
                if (m.type === 'attributes' && m.attributeName && m.target.nodeType === 1) {
                    // Re-translate placeholder/title if changed by app.
                    translateAttrs(m.target);
                }
            }
        });
        obs.observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'],
        });
    }

    function applyLangAttrs() {
        const lang = getUiLang();
        document.documentElement.setAttribute('data-ui-lang', lang);
        if (RTL[lang]) {
            document.documentElement.setAttribute('dir', 'rtl');
        } else {
            document.documentElement.setAttribute('dir', 'ltr');
        }
    }

    function init() {
        applyLangAttrs();
        if (getUiLang() !== 'en') {
            translateTree(document.body);
        }
        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.omnoteUiI18n = { translate: translateTree, dict: DICT };
})();
