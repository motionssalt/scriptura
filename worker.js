// ═══════════════════════════════════════════════════════════════
// Scriptura — Cloudflare Workers + D1 port
// MOTIONSALT
// Functionally identical to the original Supabase/Deno version.
// ═══════════════════════════════════════════════════════════════
const TOTAL_CH = 1189;
const CHANNEL = "https://t.me/motionsalt";

// ═══════════════════════════════════════════════════════════════
// CHANNEL-FOLLOW GATE — @motionsalt subscription check
// ───────────────────────────────────────────────────────────────
// Every incoming update is routed through checkMembership() first;
// only users whose status is `member`, `administrator`, or `creator`
// in @motionsalt are allowed through to the normal handlers. Anything
// else (including `left`, `kicked`, or ANY error from Telegram) is
// treated as "not a member" — fail closed, never fail open.
//
// IMPORTANT: getChatMember requires the bot to be an *admin* in the
// target chat. This bot has already been made an admin of @motionsalt.
// If it is ever removed as admin (or demoted), this call will silently
// start returning errors and the gate will lock EVERYONE out — the
// bot must remain an admin of @motionsalt for the feature to work.
//
// Verified users are cached in KV under `membership:<user_id>` with a
// 1-hour TTL, so repeat messages from an already-verified user don't
// hammer the Telegram API but the check still re-validates periodically
// in case the user leaves the channel later.
// ═══════════════════════════════════════════════════════════════
const CHANNEL_USERNAME = "@motionsalt";
const MEMBERSHIP_CACHE_TTL = 3600; // 1 hour, in seconds

/**
 * Query Telegram for the user's membership status in @motionsalt.
 * Returns true only on `member` / `administrator` / `creator`.
 * Any other status, any HTTP error, any parse failure → false.
 * (Fail closed — do NOT let users through when the lookup errors.)
 */
async function isChannelMember(env, userId) {
    try {
        const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getChatMember` +
            `?chat_id=${encodeURIComponent(CHANNEL_USERNAME)}&user_id=${userId}`;
        const res = await fetch(url);
        if (!res.ok)
            return false;
        const json = await res.json();
        if (!json.ok || !json.result)
            return false;
        const status = json.result.status;
        return status === "member" || status === "administrator" || status === "creator";
    }
    catch (_err) {
        return false;
    }
}

/**
 * Verify the user is a channel member, using a short-lived KV cache
 * to avoid re-hitting the Telegram API on every incoming update.
 * Cache stores only positive verifications; negative results are
 * re-checked every time so a user who just joined isn't kept out.
 */
async function checkMembership(env, userId) {
    if (!userId)
        return false;
    const key = `membership:${userId}`;
    // Cache is optional — if the KV binding is missing for any reason,
    // fall back to a live check on every message rather than crashing.
    if (env.SCRIPTURA_KV) {
        try {
            const cached = await env.SCRIPTURA_KV.get(key);
            if (cached === "verified")
                return true;
        }
        catch (_err) { /* KV read failed — treat as cache miss */ }
    }
    const ok = await isChannelMember(env, userId);
    if (ok && env.SCRIPTURA_KV) {
        try {
            await env.SCRIPTURA_KV.put(key, "verified", { expirationTtl: MEMBERSHIP_CACHE_TTL });
        }
        catch (_err) { /* cache write failure is non-fatal */ }
    }
    return ok;
}

/**
 * Send the "you must join @motionsalt first" gate message with the
 * Join + Re-check inline buttons. Used both as the initial block and
 * as the response when a user taps "I've Joined" but still isn't in.
 */
async function sendGateMessage(env, chatId) {
    const text = `🔒 <b>Join @motionsalt first</b> to use this bot.\n\n` +
        `Once you've joined, tap the button below to continue.`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📢 Join @motionsalt", url: CHANNEL }],
            [{ text: "✅ I've Joined — Check Again", callback_data: "check_membership" }],
        ],
    };
    await sendMessage(env, chatId, text, keyboard);
}

/**
 * Extract the acting user's ID from any inbound update shape we handle
 * (message / edited_message / callback_query). Returns null when no
 * user is attached, in which case the update is dropped.
 */
function extractUserId(update) {
    if (update.callback_query?.from?.id)
        return update.callback_query.from.id;
    if (update.message?.from?.id)
        return update.message.from.id;
    if (update.edited_message?.from?.id)
        return update.edited_message.from.id;
    return null;
}

/**
 * Extract the chat ID we should reply to for the gate message.
 * For callback queries this is the source of the tapped button;
 * for direct messages it's the chat the message came from.
 */
function extractChatId(update) {
    if (update.callback_query?.message?.chat?.id)
        return update.callback_query.message.chat.id;
    if (update.message?.chat?.id)
        return update.message.chat.id;
    if (update.edited_message?.chat?.id)
        return update.edited_message.chat.id;
    return null;
}

// ═══════════════════════════════════════════════════════════════
// D1 HELPERS — every read parses JSON columns, every write stringifies
// ═══════════════════════════════════════════════════════════════
function safeParseArr(s) {
    if (Array.isArray(s))
        return s;
    if (typeof s !== "string" || !s)
        return [];
    try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : [];
    }
    catch {
        return [];
    }
}
async function getUser(env, userId) {
    const row = await env.DB
        .prepare("SELECT * FROM scriptura_progress WHERE user_id = ?")
        .bind(userId)
        .first();
    if (!row)
        return null;
    return {
        user_id: Number(row.user_id),
        start_date: row.start_date,
        plan_days: Number(row.plan_days),
        reading_mode: row.reading_mode,
        completed_days: safeParseArr(row.completed_days),
        book_order: safeParseArr(row.book_order),
        streak: Number(row.streak ?? 0),
        last_read_date: row.last_read_date ?? null,
        waiting_for: row.waiting_for ?? null,
        created_at: row.created_at,
    };
}
// ═══════════════════════════════════════════════════════════════
// MOTIVATIONAL QUOTES
// Fetched from ZenQuotes API with a faith-based fallback list.
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// BIBLE QUOTES — 500 curated KJV scriptures, zero external API
// Random pick on every call — instant, offline, no rate limits
// ═══════════════════════════════════════════════════════════════
const BIBLE_QUOTES = [
    { q: "Now faith is the substance of things hoped for, the evidence of things not seen.", a: "Hebrews 11:1" },
    { q: "Trust in the LORD with all thine heart; and lean not unto thine own understanding.", a: "Proverbs 3:5" },
    { q: "In all thy ways acknowledge him, and he shall direct thy paths.", a: "Proverbs 3:6" },
    { q: "The LORD is my shepherd; I shall not want.", a: "Psalm 23:1" },
    { q: "Yea, though I walk through the valley of the shadow of death, I will fear no evil.", a: "Psalm 23:4" },
    { q: "Blessed is the man that trusteth in the LORD, and whose hope the LORD is.", a: "Jeremiah 17:7" },
    { q: "Commit thy way unto the LORD; trust also in him; and he shall bring it to pass.", a: "Psalm 37:5" },
    { q: "They that trust in the LORD shall be as mount Zion, which cannot be removed.", a: "Psalm 125:1" },
    { q: "For we walk by faith, not by sight.", a: "2 Corinthians 5:7" },
    { q: "Jesus said unto him, If thou canst believe, all things are possible to him that believeth.", a: "Mark 9:23" },
    { q: "According to your faith be it unto you.", a: "Matthew 9:29" },
    { q: "Have faith in God.", a: "Mark 11:22" },
    { q: "So then faith cometh by hearing, and hearing by the word of God.", a: "Romans 10:17" },
    { q: "The just shall live by faith.", a: "Romans 1:17" },
    { q: "Without faith it is impossible to please him.", a: "Hebrews 11:6" },
    { q: "If ye have faith as a grain of mustard seed, ye shall say unto this mountain, Remove hence, and it shall remove.", a: "Matthew 17:20" },
    { q: "Fight the good fight of faith.", a: "1 Timothy 6:12" },
    { q: "Cast not away therefore your confidence, which hath great recompence of reward.", a: "Hebrews 10:35" },
    { q: "But let him ask in faith, nothing wavering.", a: "James 1:6" },
    { q: "For whatsoever is born of God overcometh the world: and this is the victory that overcometh the world, even our faith.", a: "1 John 5:4" },
    { q: "I can do all things through Christ which strengtheneth me.", a: "Philippians 4:13" },
    { q: "Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee.", a: "Joshua 1:9" },
    { q: "The LORD is my strength and my shield; my heart trusted in him, and I am helped.", a: "Psalm 28:7" },
    { q: "He giveth power to the faint; and to them that have no might he increaseth strength.", a: "Isaiah 40:29" },
    { q: "But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.", a: "Isaiah 40:31" },
    { q: "God is our refuge and strength, a very present help in trouble.", a: "Psalm 46:1" },
    { q: "The LORD is my light and my salvation; whom shall I fear?", a: "Psalm 27:1" },
    { q: "Be strong in the Lord, and in the power of his might.", a: "Ephesians 6:10" },
    { q: "Finally, my brethren, be strong in the Lord.", a: "Ephesians 6:10" },
    { q: "Watch ye, stand fast in the faith, quit you like men, be strong.", a: "1 Corinthians 16:13" },
    { q: "The LORD will give strength unto his people; the LORD will bless his people with peace.", a: "Psalm 29:11" },
    { q: "My strength is dried up like a potsherd; thou hearest me: be not far from me, O LORD.", a: "Psalm 22:15" },
    { q: "In the day when I cried thou answeredst me, and strengthenedst me with strength in my soul.", a: "Psalm 138:3" },
    { q: "Strengthened with all might, according to his glorious power.", a: "Colossians 1:11" },
    { q: "My grace is sufficient for thee: for my strength is made perfect in weakness.", a: "2 Corinthians 12:9" },
    { q: "Most gladly therefore will I rather glory in my infirmities, that the power of Christ may rest upon me.", a: "2 Corinthians 12:9" },
    { q: "The LORD upholdeth all that fall, and raiseth up all those that be bowed down.", a: "Psalm 145:14" },
    { q: "Fear thou not; for I am with thee: be not dismayed; for I am thy God: I will strengthen thee.", a: "Isaiah 41:10" },
    { q: "I will uphold thee with the right hand of my righteousness.", a: "Isaiah 41:10" },
    { q: "Be of good courage, and he shall strengthen your heart, all ye that hope in the LORD.", a: "Psalm 31:24" },
    { q: "For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.", a: "Jeremiah 29:11" },
    { q: "And we know that all things work together for good to them that love God.", a: "Romans 8:28" },
    { q: "For I reckon that the sufferings of this present time are not worthy to be compared with the glory which shall be revealed in us.", a: "Romans 8:18" },
    { q: "Hope deferred maketh the heart sick: but when the desire cometh, it is a tree of life.", a: "Proverbs 13:12" },
    { q: "Blessed is the man that endureth temptation: for when he is tried, he shall receive the crown of life.", a: "James 1:12" },
    { q: "For thou art my hope, O Lord GOD: thou art my trust from my youth.", a: "Psalm 71:5" },
    { q: "Why art thou cast down, O my soul? and why art thou disquieted in me? hope thou in God.", a: "Psalm 42:5" },
    { q: "The LORD taketh pleasure in them that fear him, in those that hope in his mercy.", a: "Psalm 147:11" },
    { q: "Behold, the eye of the LORD is upon them that fear him, upon them that hope in his mercy.", a: "Psalm 33:18" },
    { q: "Be of good courage, and he shall strengthen your heart, all ye that hope in the LORD.", a: "Psalm 31:24" },
    { q: "And hope maketh not ashamed; because the love of God is shed abroad in our hearts.", a: "Romans 5:5" },
    { q: "Rejoicing in hope; patient in tribulation; continuing instant in prayer.", a: "Romans 12:12" },
    { q: "Now the God of hope fill you with all joy and peace in believing.", a: "Romans 15:13" },
    { q: "Which hope we have as an anchor of the soul, both sure and stedfast.", a: "Hebrews 6:19" },
    { q: "Looking for that blessed hope, and the glorious appearing of the great God and our Saviour Jesus Christ.", a: "Titus 2:13" },
    { q: "But I will hope continually, and will yet praise thee more and more.", a: "Psalm 71:14" },
    { q: "The LORD is good unto them that wait for him, to the soul that seeketh him.", a: "Lamentations 3:25" },
    { q: "It is good that a man should both hope and quietly wait for the salvation of the LORD.", a: "Lamentations 3:26" },
    { q: "Behold, I will do a new thing; now it shall spring forth; shall ye not know it?", a: "Isaiah 43:19" },
    { q: "For the LORD God is a sun and shield: the LORD will give grace and glory.", a: "Psalm 84:11" },
    { q: "For God so loved the world, that he gave his only begotten Son.", a: "John 3:16" },
    { q: "Greater love hath no man than this, that a man lay down his life for his friends.", a: "John 15:13" },
    { q: "Herein is love, not that we loved God, but that he loved us.", a: "1 John 4:10" },
    { q: "We love him, because he first loved us.", a: "1 John 4:19" },
    { q: "The LORD hath appeared of old unto me, saying, Yea, I have loved thee with an everlasting love.", a: "Jeremiah 31:3" },
    { q: "Beloved, let us love one another: for love is of God.", a: "1 John 4:7" },
    { q: "Charity suffereth long, and is kind; charity envieth not.", a: "1 Corinthians 13:4" },
    { q: "And now abideth faith, hope, charity, these three; but the greatest of these is charity.", a: "1 Corinthians 13:13" },
    { q: "But God commendeth his love toward us, in that, while we were yet sinners, Christ died for us.", a: "Romans 5:8" },
    { q: "For I am persuaded, that neither death, nor life, nor angels, nor principalities, nor powers, shall be able to separate us from the love of God.", a: "Romans 8:38-39" },
    { q: "The LORD is merciful and gracious, slow to anger, and plenteous in mercy.", a: "Psalm 103:8" },
    { q: "It is of the LORD's mercies that we are not consumed, because his compassions fail not.", a: "Lamentations 3:22" },
    { q: "They are new every morning: great is thy faithfulness.", a: "Lamentations 3:23" },
    { q: "For the LORD is good; his mercy is everlasting; and his truth endureth to all generations.", a: "Psalm 100:5" },
    { q: "O give thanks unto the LORD; for he is good: for his mercy endureth for ever.", a: "Psalm 136:1" },
    { q: "But thou, O Lord, art a God full of compassion, and gracious, long-suffering, and plenteous in mercy and truth.", a: "Psalm 86:15" },
    { q: "The LORD thy God in the midst of thee is mighty; he will save, he will rejoice over thee with joy.", a: "Zephaniah 3:17" },
    { q: "Yea, I have loved thee with an everlasting love: therefore with lovingkindness have I drawn thee.", a: "Jeremiah 31:3" },
    { q: "And the grace of our Lord was exceeding abundant with faith and love which is in Christ Jesus.", a: "1 Timothy 1:14" },
    { q: "Grace be unto you, and peace, from God our Father, and from the Lord Jesus Christ.", a: "Philippians 1:2" },
    { q: "Peace I leave with you, my peace I give unto you.", a: "John 14:27" },
    { q: "Thou wilt keep him in perfect peace, whose mind is stayed on thee: because he trusteth in thee.", a: "Isaiah 26:3" },
    { q: "And the peace of God, which passeth all understanding, shall keep your hearts and minds through Christ Jesus.", a: "Philippians 4:7" },
    { q: "Be careful for nothing; but in every thing by prayer and supplication with thanksgiving let your requests be made known unto God.", a: "Philippians 4:6" },
    { q: "Cast thy burden upon the LORD, and he shall sustain thee.", a: "Psalm 55:22" },
    { q: "Come unto me, all ye that labour and are heavy laden, and I will give you rest.", a: "Matthew 11:28" },
    { q: "Take my yoke upon you, and learn of me; for I am meek and lowly in heart: and ye shall find rest unto your souls.", a: "Matthew 11:29" },
    { q: "He maketh me to lie down in green pastures: he leadeth me beside the still waters.", a: "Psalm 23:2" },
    { q: "He restoreth my soul: he leadeth me in the paths of righteousness for his name's sake.", a: "Psalm 23:3" },
    { q: "Rest in the LORD, and wait patiently for him.", a: "Psalm 37:7" },
    { q: "Great peace have they which love thy law: and nothing shall offend them.", a: "Psalm 119:165" },
    { q: "The LORD bless thee, and keep thee: the LORD make his face shine upon thee.", a: "Numbers 6:24-25" },
    { q: "And he said, My presence shall go with thee, and I will give thee rest.", a: "Exodus 33:14" },
    { q: "Return unto thy rest, O my soul; for the LORD hath dealt bountifully with thee.", a: "Psalm 116:7" },
    { q: "I will both lay me down in peace, and sleep: for thou, LORD, only makest me dwell in safety.", a: "Psalm 4:8" },
    { q: "Be still, and know that I am God.", a: "Psalm 46:10" },
    { q: "Lord, thou wilt ordain peace for us: for thou also hast wrought all our works in us.", a: "Isaiah 26:12" },
    { q: "How beautiful upon the mountains are the feet of him that bringeth good tidings, that publisheth peace.", a: "Isaiah 52:7" },
    { q: "For he is our peace, who hath made both one, and hath broken down the middle wall of partition between us.", a: "Ephesians 2:14" },
    { q: "Now the Lord of peace himself give you peace always by all means.", a: "2 Thessalonians 3:16" },
    { q: "If any of you lack wisdom, let him ask of God, that giveth to all men liberally.", a: "James 1:5" },
    { q: "The fear of the LORD is the beginning of wisdom: a good understanding have all they that do his commandments.", a: "Psalm 111:10" },
    { q: "For the LORD giveth wisdom: out of his mouth cometh knowledge and understanding.", a: "Proverbs 2:6" },
    { q: "Thy word is a lamp unto my feet, and a light unto my path.", a: "Psalm 119:105" },
    { q: "The entrance of thy words giveth light; it giveth understanding unto the simple.", a: "Psalm 119:130" },
    { q: "Thy testimonies are wonderful: therefore doth my soul keep them.", a: "Psalm 119:129" },
    { q: "Wherewithal shall a young man cleanse his way? by taking heed thereto according to thy word.", a: "Psalm 119:9" },
    { q: "Thy word have I hid in mine heart, that I might not sin against thee.", a: "Psalm 119:11" },
    { q: "For the word of God is quick, and powerful, and sharper than any twoedged sword.", a: "Hebrews 4:12" },
    { q: "All scripture is given by inspiration of God, and is profitable for doctrine.", a: "2 Timothy 3:16" },
    { q: "This book of the law shall not depart out of thy mouth; but thou shalt meditate therein day and night.", a: "Joshua 1:8" },
    { q: "Blessed is he that readeth, and they that hear the words of this prophecy.", a: "Revelation 1:3" },
    { q: "Man shall not live by bread alone, but by every word that proceedeth out of the mouth of God.", a: "Matthew 4:4" },
    { q: "The law of the LORD is perfect, converting the soul.", a: "Psalm 19:7" },
    { q: "The statutes of the LORD are right, rejoicing the heart.", a: "Psalm 19:8" },
    { q: "The commandment of the LORD is pure, enlightening the eyes.", a: "Psalm 19:8" },
    { q: "More to be desired are they than gold, yea, than much fine gold: sweeter also than honey.", a: "Psalm 19:10" },
    { q: "Open thou mine eyes, that I may behold wondrous things out of thy law.", a: "Psalm 119:18" },
    { q: "I have more understanding than all my teachers: for thy testimonies are my meditation.", a: "Psalm 119:99" },
    { q: "Thy word is very pure: therefore thy servant loveth it.", a: "Psalm 119:140" },
    { q: "Ask, and it shall be given you; seek, and ye shall find; knock, and it shall be opened unto you.", a: "Matthew 7:7" },
    { q: "Therefore I say unto you, What things soever ye desire, when ye pray, believe that ye receive them.", a: "Mark 11:24" },
    { q: "If ye shall ask any thing in my name, I will do it.", a: "John 14:14" },
    { q: "The effectual fervent prayer of a righteous man availeth much.", a: "James 5:16" },
    { q: "Pray without ceasing.", a: "1 Thessalonians 5:17" },
    { q: "Evening, and morning, and at noon, will I pray, and cry aloud: and he shall hear my voice.", a: "Psalm 55:17" },
    { q: "Call unto me, and I will answer thee, and shew thee great and mighty things, which thou knowest not.", a: "Jeremiah 33:3" },
    { q: "The LORD is nigh unto all them that call upon him, to all that call upon him in truth.", a: "Psalm 145:18" },
    { q: "And whatsoever ye shall ask in my name, that will I do, that the Father may be glorified in the Son.", a: "John 14:13" },
    { q: "Continue in prayer, and watch in the same with thanksgiving.", a: "Colossians 4:2" },
    { q: "Let us therefore come boldly unto the throne of grace, that we may obtain mercy, and find grace to help in time of need.", a: "Hebrews 4:16" },
    { q: "And this is the confidence that we have in him, that, if we ask any thing according to his will, he heareth us.", a: "1 John 5:14" },
    { q: "But thou, when thou prayest, enter into thy closet, and when thou hast shut thy door, pray to thy Father which is in secret.", a: "Matthew 6:6" },
    { q: "Be careful for nothing; but in every thing by prayer and supplication with thanksgiving.", a: "Philippians 4:6" },
    { q: "I cried unto the LORD with my voice; with my voice unto the LORD did I make my supplication.", a: "Psalm 142:1" },
    { q: "Out of the depths have I cried unto thee, O LORD. Lord, hear my voice.", a: "Psalm 130:1-2" },
    { q: "He shall call upon me, and I will answer him: I will be with him in trouble.", a: "Psalm 91:15" },
    { q: "Before they call, I will answer; and while they are yet speaking, I will hear.", a: "Isaiah 65:24" },
    { q: "The sacrifice of the wicked is an abomination to the LORD: but the prayer of the upright is his delight.", a: "Proverbs 15:8" },
    { q: "Confess your faults one to another, and pray one for another, that ye may be healed.", a: "James 5:16" },
    { q: "Rejoice in the Lord alway: and again I say, Rejoice.", a: "Philippians 4:4" },
    { q: "This is the day which the LORD hath made; we will rejoice and be glad in it.", a: "Psalm 118:24" },
    { q: "The joy of the LORD is your strength.", a: "Nehemiah 8:10" },
    { q: "Shout for joy to the LORD, all the earth. Worship the LORD with gladness.", a: "Psalm 100:1-2" },
    { q: "Sing unto the LORD a new song; sing unto the LORD, all the earth.", a: "Psalm 96:1" },
    { q: "Praise ye the LORD. Praise God in his sanctuary: praise him in the firmament of his power.", a: "Psalm 150:1" },
    { q: "Let every thing that hath breath praise the LORD. Praise ye the LORD.", a: "Psalm 150:6" },
    { q: "O come, let us sing unto the LORD: let us make a joyful noise to the rock of our salvation.", a: "Psalm 95:1" },
    { q: "Make a joyful noise unto the LORD, all ye lands.", a: "Psalm 100:1" },
    { q: "Bless the LORD, O my soul: and all that is within me, bless his holy name.", a: "Psalm 103:1" },
    { q: "I will bless the LORD at all times: his praise shall continually be in my mouth.", a: "Psalm 34:1" },
    { q: "Praise ye the LORD: for it is good to sing praises unto our God.", a: "Psalm 147:1" },
    { q: "Oh that men would praise the LORD for his goodness, and for his wonderful works to the children of men!", a: "Psalm 107:8" },
    { q: "Sing praises to God, sing praises: sing praises unto our King, sing praises.", a: "Psalm 47:6" },
    { q: "Let the word of Christ dwell in you richly in all wisdom; singing with grace in your hearts to the Lord.", a: "Colossians 3:16" },
    { q: "Speaking to yourselves in psalms and hymns and spiritual songs, singing and making melody in your heart to the Lord.", a: "Ephesians 5:19" },
    { q: "My heart rejoiceth in the LORD, mine horn is exalted in the LORD.", a: "1 Samuel 2:1" },
    { q: "The LORD thy God in the midst of thee is mighty; he will save, he will rejoice over thee with joy.", a: "Zephaniah 3:17" },
    { q: "Weeping may endure for a night, but joy cometh in the morning.", a: "Psalm 30:5" },
    { q: "Thou hast turned for me my mourning into dancing: thou hast put off my sackcloth, and girded me with gladness.", a: "Psalm 30:11" },
    { q: "For the LORD God is a sun and shield: the LORD will give grace and glory: no good thing will he withhold.", a: "Psalm 84:11" },
    { q: "The LORD is faithful, who shall stablish you, and keep you from evil.", a: "2 Thessalonians 3:3" },
    { q: "God is not a man, that he should lie; neither the son of man, that he should repent.", a: "Numbers 23:19" },
    { q: "For all the promises of God in him are yea, and in him Amen.", a: "2 Corinthians 1:20" },
    { q: "Heaven and earth shall pass away, but my words shall not pass away.", a: "Matthew 24:35" },
    { q: "The grass withereth, the flower fadeth: but the word of our God shall stand for ever.", a: "Isaiah 40:8" },
    { q: "There hath not failed one word of all his good promise.", a: "1 Kings 8:56" },
    { q: "My covenant will I not break, nor alter the thing that is gone out of my lips.", a: "Psalm 89:34" },
    { q: "He hath remembered his covenant for ever, the word which he commanded to a thousand generations.", a: "Psalm 105:8" },
    { q: "For the mountains shall depart, and the hills be removed; but my kindness shall not depart from thee.", a: "Isaiah 54:10" },
    { q: "I will never leave thee, nor forsake thee.", a: "Hebrews 13:5" },
    { q: "Lo, I am with you alway, even unto the end of the world.", a: "Matthew 28:20" },
    { q: "And, behold, I am with thee, and will keep thee in all places whither thou goest.", a: "Genesis 28:15" },
    { q: "The LORD himself goeth before thee; he will be with thee, he will not fail thee, neither forsake thee.", a: "Deuteronomy 31:8" },
    { q: "Fear not: for I have redeemed thee, I have called thee by thy name; thou art mine.", a: "Isaiah 43:1" },
    { q: "When thou passest through the waters, I will be with thee; and through the rivers, they shall not overflow thee.", a: "Isaiah 43:2" },
    { q: "No weapon that is formed against thee shall prosper.", a: "Isaiah 54:17" },
    { q: "For I the LORD thy God will hold thy right hand, saying unto thee, Fear not; I will help thee.", a: "Isaiah 41:13" },
    { q: "Casting all your care upon him; for he careth for you.", a: "1 Peter 5:7" },
    { q: "And my God shall supply all your need according to his riches in glory by Christ Jesus.", a: "Philippians 4:19" },
    { q: "And let us not be weary in well doing: for in due season we shall reap, if we faint not.", a: "Galatians 6:9" },
    { q: "Blessed is the man that endureth temptation: for when he is tried, he shall receive the crown of life.", a: "James 1:12" },
    { q: "Tribulation worketh patience; and patience, experience; and experience, hope.", a: "Romans 5:3-4" },
    { q: "I have fought a good fight, I have finished my course, I have kept the faith.", a: "2 Timothy 4:7" },
    { q: "Let us run with patience the race that is set before us.", a: "Hebrews 12:1" },
    { q: "Looking unto Jesus the author and finisher of our faith.", a: "Hebrews 12:2" },
    { q: "For ye have need of patience, that, after ye have done the will of God, ye might receive the promise.", a: "Hebrews 10:36" },
    { q: "In your patience possess ye your souls.", a: "Luke 21:19" },
    { q: "He that shall endure unto the end, the same shall be saved.", a: "Matthew 24:13" },
    { q: "Be thou faithful unto death, and I will give thee a crown of life.", a: "Revelation 2:10" },
    { q: "To him that overcometh will I grant to sit with me in my throne.", a: "Revelation 3:21" },
    { q: "But he that shall endure unto the end, the same shall be saved.", a: "Mark 13:13" },
    { q: "And ye shall be hated of all men for my name's sake: but he that endureth to the end shall be saved.", a: "Matthew 10:22" },
    { q: "My brethren, count it all joy when ye fall into divers temptations; knowing this, that the trying of your faith worketh patience.", a: "James 1:2-3" },
    { q: "Let patience have her perfect work, that ye may be perfect and entire, wanting nothing.", a: "James 1:4" },
    { q: "But they that wait upon the LORD shall renew their strength.", a: "Isaiah 40:31" },
    { q: "Wait on the LORD: be of good courage, and he shall strengthen thine heart.", a: "Psalm 27:14" },
    { q: "I waited patiently for the LORD; and he inclined unto me, and heard my cry.", a: "Psalm 40:1" },
    { q: "Be still before the LORD and wait patiently for him.", a: "Psalm 37:7" },
    { q: "The LORD is good unto them that wait for him, to the soul that seeketh him.", a: "Lamentations 3:25" },
    { q: "Nay, in all these things we are more than conquerors through him that loved us.", a: "Romans 8:37" },
    { q: "For whatsoever is born of God overcometh the world: and this is the victory that overcometh the world, even our faith.", a: "1 John 5:4" },
    { q: "But thanks be to God, which giveth us the victory through our Lord Jesus Christ.", a: "1 Corinthians 15:57" },
    { q: "If God be for us, who can be against us?", a: "Romans 8:31" },
    { q: "Submit yourselves therefore to God. Resist the devil, and he will flee from you.", a: "James 4:7" },
    { q: "Greater is he that is in you, than he that is in the world.", a: "1 John 4:4" },
    { q: "The LORD shall fight for you, and ye shall hold your peace.", a: "Exodus 14:14" },
    { q: "No weapon that is formed against thee shall prosper.", a: "Isaiah 54:17" },
    { q: "Blessed be the LORD my strength, which teacheth my hands to war, and my fingers to fight.", a: "Psalm 144:1" },
    { q: "Through God we shall do valiantly: for he it is that shall tread down our enemies.", a: "Psalm 60:12" },
    { q: "The LORD is a man of war: the LORD is his name.", a: "Exodus 15:3" },
    { q: "For thou hast girded me with strength unto the battle.", a: "Psalm 18:39" },
    { q: "It is God that girdeth me with strength, and maketh my way perfect.", a: "Psalm 18:32" },
    { q: "Thou hast also given me the shield of thy salvation.", a: "Psalm 18:35" },
    { q: "He teacheth my hands to war, so that a bow of steel is broken by mine arms.", a: "Psalm 18:34" },
    { q: "The LORD liveth; and blessed be my rock; and exalted be the God of the rock of my salvation.", a: "2 Samuel 22:47" },
    { q: "For by thee I have run through a troop; by my God have I leaped over a wall.", a: "Psalm 18:29" },
    { q: "He maketh my feet like hinds' feet, and setteth me upon my high places.", a: "Psalm 18:33" },
    { q: "Thanks be to God, which always causeth us to triumph in Christ.", a: "2 Corinthians 2:14" },
    { q: "Behold, I give unto you power to tread on serpents and scorpions, and over all the power of the enemy.", a: "Luke 10:19" },
    { q: "But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.", a: "Matthew 6:33" },
    { q: "Create in me a clean heart, O God; and renew a right spirit within me.", a: "Psalm 51:10" },
    { q: "Blessed are the pure in heart: for they shall see God.", a: "Matthew 5:8" },
    { q: "Blessed are they which do hunger and thirst after righteousness: for they shall be filled.", a: "Matthew 5:6" },
    { q: "The effectual fervent prayer of a righteous man availeth much.", a: "James 5:16" },
    { q: "The righteous shall flourish like the palm tree: he shall grow like a cedar in Lebanon.", a: "Psalm 92:12" },
    { q: "Many are the afflictions of the righteous: but the LORD delivereth him out of them all.", a: "Psalm 34:19" },
    { q: "The steps of a good man are ordered by the LORD: and he delighteth in his way.", a: "Psalm 37:23" },
    { q: "Though he fall, he shall not be utterly cast down: for the LORD upholdeth him with his hand.", a: "Psalm 37:24" },
    { q: "I have been young, and now am old; yet have I not seen the righteous forsaken.", a: "Psalm 37:25" },
    { q: "For the righteous LORD loveth righteousness; his countenance doth behold the upright.", a: "Psalm 11:7" },
    { q: "Light is sown for the righteous, and gladness for the upright in heart.", a: "Psalm 97:11" },
    { q: "The path of the just is as the shining light, that shineth more and more unto the perfect day.", a: "Proverbs 4:18" },
    { q: "Righteousness exalteth a nation: but sin is a reproach to any people.", a: "Proverbs 14:34" },
    { q: "For he hath made him to be sin for us, who knew no sin; that we might be made the righteousness of God in him.", a: "2 Corinthians 5:21" },
    { q: "Follow peace with all men, and holiness, without which no man shall see the Lord.", a: "Hebrews 12:14" },
    { q: "Be ye holy; for I am holy.", a: "1 Peter 1:16" },
    { q: "Blessed are they that keep his testimonies, and that seek him with the whole heart.", a: "Psalm 119:2" },
    { q: "Thy word have I hid in mine heart, that I might not sin against thee.", a: "Psalm 119:11" },
    { q: "I delight to do thy will, O my God: yea, thy law is within my heart.", a: "Psalm 40:8" },
    { q: "The LORD is my shepherd; I shall not want.", a: "Psalm 23:1" },
    { q: "And my God shall supply all your need according to his riches in glory by Christ Jesus.", a: "Philippians 4:19" },
    { q: "Seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.", a: "Matthew 6:33" },
    { q: "Give, and it shall be given unto you; good measure, pressed down, and shaken together, and running over.", a: "Luke 6:38" },
    { q: "Bring ye all the tithes into the storehouse, and I will open you the windows of heaven.", a: "Malachi 3:10" },
    { q: "But my God shall supply all your need according to his riches in glory by Christ Jesus.", a: "Philippians 4:19" },
    { q: "The young lions do lack, and suffer hunger: but they that seek the LORD shall not want any good thing.", a: "Psalm 34:10" },
    { q: "He that hath a bountiful eye shall be blessed; for he giveth of his bread to the poor.", a: "Proverbs 22:9" },
    { q: "There is that scattereth, and yet increaseth; and there is that withholdeth more than is meet, but it tendeth to poverty.", a: "Proverbs 11:24" },
    { q: "The blessing of the LORD, it maketh rich, and he addeth no sorrow with it.", a: "Proverbs 10:22" },
    { q: "I have been young, and now am old; yet have I not seen the righteous forsaken, nor his seed begging bread.", a: "Psalm 37:25" },
    { q: "O LORD of hosts, blessed is the man that trusteth in thee.", a: "Psalm 84:12" },
    { q: "For the LORD God is a sun and shield: the LORD will give grace and glory.", a: "Psalm 84:11" },
    { q: "No good thing will he withhold from them that walk uprightly.", a: "Psalm 84:11" },
    { q: "Honour the LORD with thy substance, and with the firstfruits of all thine increase.", a: "Proverbs 3:9" },
    { q: "So shall thy barns be filled with plenty, and thy presses shall burst out with new wine.", a: "Proverbs 3:10" },
    { q: "And the LORD shall make thee plenteous in goods.", a: "Deuteronomy 28:11" },
    { q: "Beloved, I wish above all things that thou mayest prosper and be in health, even as thy soul prospereth.", a: "3 John 1:2" },
    { q: "The meek shall inherit the earth; and shall delight themselves in the abundance of peace.", a: "Psalm 37:11" },
    { q: "He that spared not his own Son, but delivered him up for us all, how shall he not with him also freely give us all things?", a: "Romans 8:32" },
    { q: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", a: "John 3:16" },
    { q: "For by grace are ye saved through faith; and that not of yourselves: it is the gift of God.", a: "Ephesians 2:8" },
    { q: "That if thou shalt confess with thy mouth the Lord Jesus, and shalt believe in thine heart that God hath raised him from the dead, thou shalt be saved.", a: "Romans 10:9" },
    { q: "For whosoever shall call upon the name of the Lord shall be saved.", a: "Romans 10:13" },
    { q: "Jesus said unto him, I am the way, the truth, and the life.", a: "John 14:6" },
    { q: "I am the resurrection, and the life: he that believeth in me, though he were dead, yet shall he live.", a: "John 11:25" },
    { q: "Neither is there salvation in any other: for there is none other name under heaven given among men, whereby we must be saved.", a: "Acts 4:12" },
    { q: "The LORD is my rock, and my fortress, and my deliverer; my God, my strength, in whom I will trust.", a: "Psalm 18:2" },
    { q: "He only is my rock and my salvation; he is my defence; I shall not be moved.", a: "Psalm 62:6" },
    { q: "The LORD is my strength and song, and he is become my salvation.", a: "Exodus 15:2" },
    { q: "Truly my soul waiteth upon God: from him cometh my salvation.", a: "Psalm 62:1" },
    { q: "Salvation belongeth unto the LORD: thy blessing is upon thy people.", a: "Psalm 3:8" },
    { q: "He hath sent redemption unto his people: he hath commanded his covenant for ever.", a: "Psalm 111:9" },
    { q: "In whom we have redemption through his blood, even the forgiveness of sins.", a: "Colossians 1:14" },
    { q: "Who gave himself for our sins, that he might deliver us from this present evil world.", a: "Galatians 1:4" },
    { q: "Christ Jesus came into the world to save sinners.", a: "1 Timothy 1:15" },
    { q: "The Son of man is come to seek and to save that which was lost.", a: "Luke 19:10" },
    { q: "Behold, now is the accepted time; behold, now is the day of salvation.", a: "2 Corinthians 6:2" },
    { q: "If we confess our sins, he is faithful and just to forgive us our sins, and to cleanse us from all unrighteousness.", a: "1 John 1:9" },
    { q: "As far as the east is from the west, so far hath he removed our transgressions from us.", a: "Psalm 103:12" },
    { q: "To obey is better than sacrifice.", a: "1 Samuel 15:22" },
    { q: "If ye love me, keep my commandments.", a: "John 14:15" },
    { q: "Blessed are they that hear the word of God, and keep it.", a: "Luke 11:28" },
    { q: "Therefore whosoever heareth these sayings of mine, and doeth them, I will liken him unto a wise man, which built his house upon a rock.", a: "Matthew 7:24" },
    { q: "Not every one that saith unto me, Lord, Lord, shall enter into the kingdom of heaven; but he that doeth the will of my Father.", a: "Matthew 7:21" },
    { q: "Be ye doers of the word, and not hearers only, deceiving your own selves.", a: "James 1:22" },
    { q: "He that hath my commandments, and keepeth them, he it is that loveth me.", a: "John 14:21" },
    { q: "Whatsoever he saith unto you, do it.", a: "John 2:5" },
    { q: "If ye know these things, happy are ye if ye do them.", a: "John 13:17" },
    { q: "I have kept the faith.", a: "2 Timothy 4:7" },
    { q: "Moreover it is required in stewards, that a man be found faithful.", a: "1 Corinthians 4:2" },
    { q: "Well done, thou good and faithful servant: thou hast been faithful over a few things, I will make thee ruler over many things.", a: "Matthew 25:21" },
    { q: "His lord said unto him, Well done, good and faithful servant.", a: "Matthew 25:23" },
    { q: "A faithful man shall abound with blessings.", a: "Proverbs 28:20" },
    { q: "The LORD preserveth the faithful, and plentifully rewardeth the proud doer.", a: "Psalm 31:23" },
    { q: "Be thou faithful unto death, and I will give thee a crown of life.", a: "Revelation 2:10" },
    { q: "Let not mercy and truth forsake thee: bind them about thy neck; write them upon the table of thine heart.", a: "Proverbs 3:3" },
    { q: "Most men will proclaim every one his own goodness: but a faithful man who can find?", a: "Proverbs 20:6" },
    { q: "For the eyes of the LORD run to and fro throughout the whole earth, to shew himself strong in the behalf of them whose heart is perfect toward him.", a: "2 Chronicles 16:9" },
    { q: "Thou wilt shew me the path of life: in thy presence is fulness of joy; at thy right hand there are pleasures for evermore.", a: "Psalm 16:11" },
    { q: "Humble yourselves therefore under the mighty hand of God, that he may exalt you in due time.", a: "1 Peter 5:6" },
    { q: "Before honour is humility.", a: "Proverbs 15:33" },
    { q: "Pride goeth before destruction, and an haughty spirit before a fall.", a: "Proverbs 16:18" },
    { q: "He hath shewed thee, O man, what is good; and what doth the LORD require of thee, but to do justly, and to love mercy, and to walk humbly with thy God.", a: "Micah 6:8" },
    { q: "Take my yoke upon you, and learn of me; for I am meek and lowly in heart: and ye shall find rest unto your souls.", a: "Matthew 11:29" },
    { q: "Whosoever therefore shall humble himself as this little child, the same is greatest in the kingdom of heaven.", a: "Matthew 18:4" },
    { q: "But he that is greatest among you shall be your servant.", a: "Matthew 23:11" },
    { q: "God resisteth the proud, but giveth grace unto the humble.", a: "James 4:6" },
    { q: "Whosoever exalteth himself shall be abased; and he that humbleth himself shall be exalted.", a: "Luke 14:11" },
    { q: "Not by might, nor by power, but by my spirit, saith the LORD of hosts.", a: "Zechariah 4:6" },
    { q: "Let nothing be done through strife or vainglory; but in lowliness of mind let each esteem other better than themselves.", a: "Philippians 2:3" },
    { q: "Let this mind be in you, which was also in Christ Jesus.", a: "Philippians 2:5" },
    { q: "He must increase, but I must decrease.", a: "John 3:30" },
    { q: "I am the vine, ye are the branches: He that abideth in me, and I in him, the same bringeth forth much fruit.", a: "John 15:5" },
    { q: "Without me ye can do nothing.", a: "John 15:5" },
    { q: "Abide in me, and I in you.", a: "John 15:4" },
    { q: "Not my will, but thine, be done.", a: "Luke 22:42" },
    { q: "I beseech you therefore, brethren, by the mercies of God, that ye present your bodies a living sacrifice, holy, acceptable unto God.", a: "Romans 12:1" },
    { q: "Be not conformed to this world: but be ye transformed by the renewing of your mind.", a: "Romans 12:2" },
    { q: "For in him we live, and move, and have our being.", a: "Acts 17:28" },
    { q: "In every thing give thanks: for this is the will of God in Christ Jesus concerning you.", a: "1 Thessalonians 5:18" },
    { q: "O give thanks unto the LORD; for he is good: for his mercy endureth for ever.", a: "Psalm 136:1" },
    { q: "Enter into his gates with thanksgiving, and into his courts with praise.", a: "Psalm 100:4" },
    { q: "It is a good thing to give thanks unto the LORD, and to sing praises unto thy name, O most High.", a: "Psalm 92:1" },
    { q: "Thanks be unto God for his unspeakable gift.", a: "2 Corinthians 9:15" },
    { q: "By him therefore let us offer the sacrifice of praise to God continually.", a: "Hebrews 13:15" },
    { q: "Giving thanks always for all things unto God and the Father in the name of our Lord Jesus Christ.", a: "Ephesians 5:20" },
    { q: "I will offer to thee the sacrifice of thanksgiving, and will call upon the name of the LORD.", a: "Psalm 116:17" },
    { q: "The LORD is my strength and my song; and he is become my salvation.", a: "Psalm 118:14" },
    { q: "This is the day which the LORD hath made; we will rejoice and be glad in it.", a: "Psalm 118:24" },
    { q: "Oh that men would praise the LORD for his goodness, and for his wonderful works!", a: "Psalm 107:31" },
    { q: "Bless the LORD, O my soul, and forget not all his benefits.", a: "Psalm 103:2" },
    { q: "Who forgiveth all thine iniquities; who healeth all thy diseases.", a: "Psalm 103:3" },
    { q: "Who redeemeth thy life from destruction; who crowneth thee with lovingkindness and tender mercies.", a: "Psalm 103:4" },
    { q: "Who satisfieth thy mouth with good things; so that thy youth is renewed like the eagle's.", a: "Psalm 103:5" },
    { q: "Blessed be the LORD, who daily loadeth us with benefits.", a: "Psalm 68:19" },
    { q: "O LORD, thou art my God; I will exalt thee, I will praise thy name.", a: "Isaiah 25:1" },
    { q: "I will greatly rejoice in the LORD, my soul shall be joyful in my God.", a: "Isaiah 61:10" },
    { q: "Now unto the King eternal, immortal, invisible, the only wise God, be honour and glory for ever and ever.", a: "1 Timothy 1:17" },
    { q: "Unto him that loved us, and washed us from our sins in his own blood, to him be glory and dominion for ever.", a: "Revelation 1:5-6" },
    { q: "For our light and momentary troubles are achieving for us an eternal glory that far outweighs them all.", a: "2 Corinthians 4:17" },
    { q: "The LORD is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.", a: "Psalm 34:18" },
    { q: "He healeth the broken in heart, and bindeth up their wounds.", a: "Psalm 147:3" },
    { q: "Blessed are they that mourn: for they shall be comforted.", a: "Matthew 5:4" },
    { q: "Casting all your care upon him; for he careth for you.", a: "1 Peter 5:7" },
    { q: "For I reckon that the sufferings of this present time are not worthy to be compared with the glory which shall be revealed in us.", a: "Romans 8:18" },
    { q: "Who comforteth us in all our tribulation, that we may be able to comfort them which are in any trouble.", a: "2 Corinthians 1:4" },
    { q: "Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me.", a: "Psalm 23:4" },
    { q: "The LORD is close to the brokenhearted and saves those who are crushed in spirit.", a: "Psalm 34:18" },
    { q: "He shall cover thee with his feathers, and under his wings shalt thou trust.", a: "Psalm 91:4" },
    { q: "There shall no evil befall thee, neither shall any plague come nigh thy dwelling.", a: "Psalm 91:10" },
    { q: "For he shall give his angels charge over thee, to keep thee in all thy ways.", a: "Psalm 91:11" },
    { q: "When thou passest through the waters, I will be with thee.", a: "Isaiah 43:2" },
    { q: "I will not leave you comfortless: I will come to you.", a: "John 14:18" },
    { q: "And the LORD, he it is that doth go before thee; he will be with thee, he will not fail thee, neither forsake thee: fear not.", a: "Deuteronomy 31:8" },
    { q: "Fear not, for I am with you; be not dismayed, for I am your God.", a: "Isaiah 41:10" },
    { q: "When you go through deep waters, I will be with you.", a: "Isaiah 43:2" },
    { q: "The eternal God is thy refuge, and underneath are the everlasting arms.", a: "Deuteronomy 33:27" },
    { q: "He giveth power to the faint; and to them that have no might he increaseth strength.", a: "Isaiah 40:29" },
    { q: "A bruised reed shall he not break, and the smoking flax shall he not quench.", a: "Isaiah 42:3" },
    { q: "Before I formed thee in the belly I knew thee; and before thou camest forth out of the womb I sanctified thee.", a: "Jeremiah 1:5" },
    { q: "For we are his workmanship, created in Christ Jesus unto good works, which God hath before ordained that we should walk in them.", a: "Ephesians 2:10" },
    { q: "I press toward the mark for the prize of the high calling of God in Christ Jesus.", a: "Philippians 3:14" },
    { q: "For I know the plans I have for you, declares the LORD, plans to prosper you and not to harm you.", a: "Jeremiah 29:11" },
    { q: "Many are the plans in a person's heart, but it is the LORD's purpose that prevails.", a: "Proverbs 19:21" },
    { q: "The heart of man plans his way, but the LORD establishes his steps.", a: "Proverbs 16:9" },
    { q: "For we are God's handiwork, created in Christ Jesus to do good works.", a: "Ephesians 2:10" },
    { q: "Delight thyself also in the LORD: and he shall give thee the desires of thine heart.", a: "Psalm 37:4" },
    { q: "The LORD will fulfil his purpose for me; your steadfast love, O LORD, endures forever.", a: "Psalm 138:8" },
    { q: "And we know that all things work together for good to them that love God, to them who are the called according to his purpose.", a: "Romans 8:28" },
    { q: "Who hath saved us, and called us with an holy calling, not according to our works, but according to his own purpose and grace.", a: "2 Timothy 1:9" },
    { q: "For God hath not given us the spirit of fear; but of power, and of love, and of a sound mind.", a: "2 Timothy 1:7" },
    { q: "Ye have not chosen me, but I have chosen you, and ordained you, that ye should go and bring forth fruit.", a: "John 15:16" },
    { q: "Go ye therefore, and teach all nations, baptizing them in the name of the Father, and of the Son, and of the Holy Ghost.", a: "Matthew 28:19" },
    { q: "And he said unto them, Go ye into all the world, and preach the gospel to every creature.", a: "Mark 16:15" },
    { q: "The harvest truly is plentiful, but the labourers are few; pray ye therefore the Lord of the harvest.", a: "Matthew 9:37-38" },
    { q: "Let your light so shine before men, that they may see your good works, and glorify your Father which is in heaven.", a: "Matthew 5:16" },
    { q: "Ye are the light of the world. A city that is set on an hill cannot be hid.", a: "Matthew 5:14" },
    { q: "Ye are the salt of the earth.", a: "Matthew 5:13" },
    { q: "Herein is my Father glorified, that ye bear much fruit; so shall ye be my disciples.", a: "John 15:8" },
    { q: "Therefore if any man be in Christ, he is a new creature: old things are passed away; behold, all things are become new.", a: "2 Corinthians 5:17" },
    { q: "And be not conformed to this world: but be ye transformed by the renewing of your mind.", a: "Romans 12:2" },
    { q: "That ye put off concerning the former conversation the old man, which is corrupt according to the deceitful lusts.", a: "Ephesians 4:22" },
    { q: "And be renewed in the spirit of your mind; and that ye put on the new man.", a: "Ephesians 4:23-24" },
    { q: "I beseech you therefore, brethren, that ye present your bodies a living sacrifice, holy, acceptable unto God.", a: "Romans 12:1" },
    { q: "Now the Lord is that Spirit: and where the Spirit of the Lord is, there is liberty.", a: "2 Corinthians 3:17" },
    { q: "But we all, with open face beholding as in a glass the glory of the Lord, are changed into the same image from glory to glory.", a: "2 Corinthians 3:18" },
    { q: "For whom he did foreknow, he also did predestinate to be conformed to the image of his Son.", a: "Romans 8:29" },
    { q: "And the very God of peace sanctify you wholly.", a: "1 Thessalonians 5:23" },
    { q: "Being confident of this very thing, that he which hath begun a good work in you will perform it until the day of Jesus Christ.", a: "Philippians 1:6" },
    { q: "Create in me a clean heart, O God; and renew a right spirit within me.", a: "Psalm 51:10" },
    { q: "Cast me not away from thy presence; and take not thy holy spirit from me.", a: "Psalm 51:11" },
    { q: "Restore unto me the joy of thy salvation; and uphold me with thy free spirit.", a: "Psalm 51:12" },
    { q: "Wash me, and I shall be whiter than snow.", a: "Psalm 51:7" },
    { q: "Come now, and let us reason together, saith the LORD: though your sins be as scarlet, they shall be as white as snow.", a: "Isaiah 1:18" },
    { q: "I will give you a new heart and put a new spirit in you.", a: "Ezekiel 36:26" },
    { q: "I will take away the stony heart out of your flesh, and I will give you an heart of flesh.", a: "Ezekiel 36:26" },
    { q: "And I will put my spirit within you, and cause you to walk in my statutes.", a: "Ezekiel 36:27" },
    { q: "He that hath begun a good work in you will perform it until the day of Jesus Christ.", a: "Philippians 1:6" },
    { q: "Now unto him that is able to do exceeding abundantly above all that we ask or think, according to the power that worketh in us.", a: "Ephesians 3:20" },
    { q: "Behold, how good and how pleasant it is for brethren to dwell together in unity!", a: "Psalm 133:1" },
    { q: "Two are better than one; because they have a good reward for their labour.", a: "Ecclesiastes 4:9" },
    { q: "For where two or three are gathered together in my name, there am I in the midst of them.", a: "Matthew 18:20" },
    { q: "Bear ye one another's burdens, and so fulfil the law of Christ.", a: "Galatians 6:2" },
    { q: "And let us consider one another to provoke unto love and to good works.", a: "Hebrews 10:24" },
    { q: "Not forsaking the assembling of ourselves together, as the manner of some is.", a: "Hebrews 10:25" },
    { q: "Iron sharpeneth iron; so a man sharpeneth the countenance of his friend.", a: "Proverbs 27:17" },
    { q: "A friend loveth at all times, and a brother is born for adversity.", a: "Proverbs 17:17" },
    { q: "Greater love hath no man than this, that a man lay down his life for his friends.", a: "John 15:13" },
    { q: "Ye are my friends, if ye do whatsoever I command you.", a: "John 15:14" },
    { q: "By this shall all men know that ye are my disciples, if ye have love one to another.", a: "John 13:35" },
    { q: "A new commandment I give unto you, That ye love one another; as I have loved you.", a: "John 13:34" },
    { q: "Let brotherly love continue.", a: "Hebrews 13:1" },
    { q: "Be kindly affectioned one to another with brotherly love; in honour preferring one another.", a: "Romans 12:10" },
    { q: "Now I beseech you, brethren, by the name of our Lord Jesus Christ, that ye all speak the same thing.", a: "1 Corinthians 1:10" },
    { q: "That they all may be one; as thou, Father, art in me, and I in thee, that they also may be one in us.", a: "John 17:21" },
    { q: "For as the body is one, and hath many members, and all the members of that one body, being many, are one body: so also is Christ.", a: "1 Corinthians 12:12" },
    { q: "Now ye are the body of Christ, and members in particular.", a: "1 Corinthians 12:27" },
    { q: "And if one member suffer, all the members suffer with it; or one member be honoured, all the members rejoice with it.", a: "1 Corinthians 12:26" },
    { q: "Fulfil ye my joy, that ye be likeminded, having the same love, being of one accord, of one mind.", a: "Philippians 2:2" },
    { q: "Wait on the LORD: be of good courage, and he shall strengthen thine heart: wait, I say, on the LORD.", a: "Psalm 27:14" },
    { q: "My soul, wait thou only upon God; for my expectation is from him.", a: "Psalm 62:5" },
    { q: "I wait for the LORD, my soul doth wait, and in his word do I hope.", a: "Psalm 130:5" },
    { q: "Rest in the LORD, and wait patiently for him: fret not thyself because of him who prospereth in his way.", a: "Psalm 37:7" },
    { q: "It is good that a man should both hope and quietly wait for the salvation of the LORD.", a: "Lamentations 3:26" },
    { q: "Be patient therefore, brethren, unto the coming of the Lord. Behold, the husbandman waiteth for the precious fruit of the earth.", a: "James 5:7" },
    { q: "And therefore will the LORD wait, that he may be gracious unto you.", a: "Isaiah 30:18" },
    { q: "But if we hope for that we see not, then do we with patience wait for it.", a: "Romans 8:25" },
    { q: "For ye have need of patience, that, after ye have done the will of God, ye might receive the promise.", a: "Hebrews 10:36" },
    { q: "Knowing this, that the trying of your faith worketh patience. But let patience have her perfect work.", a: "James 1:3-4" },
    { q: "In your patience possess ye your souls.", a: "Luke 21:19" },
    { q: "The LORD is good unto them that wait for him, to the soul that seeketh him.", a: "Lamentations 3:25" },
    { q: "And the LORD answered me, and said, Write the vision, and make it plain upon tables, that he may run that readeth it.", a: "Habakkuk 2:2" },
    { q: "For the vision is yet for an appointed time, but at the end it shall speak, and not lie: though it tarry, wait for it.", a: "Habakkuk 2:3" },
    { q: "They that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.", a: "Isaiah 40:31" },
    { q: "They shall run, and not be weary; and they shall walk, and not faint.", a: "Isaiah 40:31" },
    { q: "The LORD is good to those who wait for him, to the soul who seeks him.", a: "Lamentations 3:25" },
    { q: "Truly I wait for the LORD; my soul waits, and in his word I hope.", a: "Psalm 130:5-6" },
    { q: "Be still before the LORD and wait patiently for him.", a: "Psalm 37:7" },
    { q: "Let thine heart be therefore perfect with the LORD our God, to walk in his statutes, and to keep his commandments.", a: "1 Kings 8:61" },
    { q: "Buy the truth, and sell it not; also wisdom, and instruction, and understanding.", a: "Proverbs 23:23" },
    { q: "Sanctify them through thy truth: thy word is truth.", a: "John 17:17" },
    { q: "And ye shall know the truth, and the truth shall make you free.", a: "John 8:32" },
    { q: "Jesus saith unto him, I am the way, the truth, and the life.", a: "John 14:6" },
    { q: "For the LORD is righteous; he loveth righteousness; his countenance doth behold the upright.", a: "Psalm 11:7" },
    { q: "A false balance is abomination to the LORD: but a just weight is his delight.", a: "Proverbs 11:1" },
    { q: "The integrity of the upright shall guide them: but the perverseness of transgressors shall destroy them.", a: "Proverbs 11:3" },
    { q: "The just man walketh in his integrity: his children are blessed after him.", a: "Proverbs 20:7" },
    { q: "He that walketh uprightly walketh surely: but he that perverteth his ways shall be known.", a: "Proverbs 10:9" },
    { q: "LORD, who shall abide in thy tabernacle? He that walketh uprightly, and worketh righteousness, and speaketh the truth in his heart.", a: "Psalm 15:1-2" },
    { q: "Behold, thou desirest truth in the inward parts: and in the hidden part thou shalt make me to know wisdom.", a: "Psalm 51:6" },
    { q: "Finally, brethren, whatsoever things are true, whatsoever things are honest, whatsoever things are just, whatsoever things are pure, think on these things.", a: "Philippians 4:8" },
    { q: "For this cause was I born, and for this cause came I into the world, that I should bear witness unto the truth.", a: "John 18:37" },
    { q: "God is a Spirit: and they that worship him must worship him in spirit and in truth.", a: "John 4:24" },
    { q: "Thy righteousness is an everlasting righteousness, and thy law is the truth.", a: "Psalm 119:142" },
    { q: "The sum of thy word is truth; and every one of thy righteous rules endures forever.", a: "Psalm 119:160" },
    { q: "For all that is in the world, the lust of the flesh, and the lust of the eyes, and the pride of life, is not of the Father, but is of the world.", a: "1 John 2:16" },
    { q: "And the world passeth away, and the lust thereof: but he that doeth the will of God abideth for ever.", a: "1 John 2:17" },
    { q: "Buy truth, and do not sell it; buy wisdom, instruction, and understanding.", a: "Proverbs 23:23" },
    { q: "Teach me thy way, O LORD; I will walk in thy truth: unite my heart to fear thy name.", a: "Psalm 86:11" },
    { q: "In my Father's house are many mansions: if it were not so, I would have told you. I go to prepare a place for you.", a: "John 14:2" },
    { q: "And if I go and prepare a place for you, I will come again, and receive you unto myself.", a: "John 14:3" },
    { q: "I am the resurrection, and the life: he that believeth in me, though he were dead, yet shall he live.", a: "John 11:25" },
    { q: "And whosoever liveth and believeth in me shall never die.", a: "John 11:26" },
    { q: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", a: "John 3:16" },
    { q: "And this is the record, that God hath given to us eternal life, and this life is in his Son.", a: "1 John 5:11" },
    { q: "And I give unto them eternal life; and they shall never perish, neither shall any man pluck them out of my hand.", a: "John 10:28" },
    { q: "For the wages of sin is death; but the gift of God is eternal life through Jesus Christ our Lord.", a: "Romans 6:23" },
    { q: "But our citizenship is in heaven, from which we also eagerly wait for the Savior, the Lord Jesus Christ.", a: "Philippians 3:20" },
    { q: "For I am in a strait betwixt two, having a desire to depart, and to be with Christ; which is far better.", a: "Philippians 1:23" },
    { q: "Eye hath not seen, nor ear heard, neither have entered into the heart of man, the things which God hath prepared for them that love him.", a: "1 Corinthians 2:9" },
    { q: "For our light and momentary troubles are achieving for us an eternal glory that far outweighs them all.", a: "2 Corinthians 4:17" },
    { q: "So when this corruptible shall have put on incorruption, and this mortal shall have put on immortality, then shall be brought to pass the saying that is written, Death is swallowed up in victory.", a: "1 Corinthians 15:54" },
    { q: "O death, where is thy sting? O grave, where is thy victory?", a: "1 Corinthians 15:55" },
    { q: "Precious in the sight of the LORD is the death of his saints.", a: "Psalm 116:15" },
    { q: "I had fainted, unless I had believed to see the goodness of the LORD in the land of the living.", a: "Psalm 27:13" },
    { q: "And God shall wipe away all tears from their eyes; and there shall be no more death, neither sorrow, nor crying.", a: "Revelation 21:4" },
    { q: "Behold, I make all things new.", a: "Revelation 21:5" },
    { q: "He that overcometh shall inherit all things; and I will be his God, and he shall be my son.", a: "Revelation 21:7" },
    { q: "Blessed are they that do his commandments, that they may have right to the tree of life.", a: "Revelation 22:14" },
    { q: "The LORD is my shepherd; I shall not want. He maketh me to lie down in green pastures.", a: "Psalm 23:1-2" },
    { q: "He leadeth me beside the still waters. He restoreth my soul.", a: "Psalm 23:2-3" },
    { q: "He leadeth me in the paths of righteousness for his name's sake.", a: "Psalm 23:3" },
    { q: "I will instruct thee and teach thee in the way which thou shalt go: I will guide thee with mine eye.", a: "Psalm 32:8" },
    { q: "The steps of a good man are ordered by the LORD: and he delighteth in his way.", a: "Psalm 37:23" },
    { q: "Thy word is a lamp unto my feet, and a light unto my path.", a: "Psalm 119:105" },
    { q: "Thine ears shall hear a word behind thee, saying, This is the way, walk ye in it.", a: "Isaiah 30:21" },
    { q: "In all thy ways acknowledge him, and he shall direct thy paths.", a: "Proverbs 3:6" },
    { q: "Trust in the LORD with all thine heart; and lean not unto thine own understanding.", a: "Proverbs 3:5" },
    { q: "A man's heart deviseth his way: but the LORD directeth his steps.", a: "Proverbs 16:9" },
    { q: "Commit thy works unto the LORD, and thy thoughts shall be established.", a: "Proverbs 16:3" },
    { q: "The LORD shall guide thee continually, and satisfy thy soul in drought.", a: "Isaiah 58:11" },
    { q: "And he will shew thee a great thing; great things, and strange things wilt thou not know.", a: "Jeremiah 33:3" },
    { q: "Howbeit when he, the Spirit of truth, is come, he will guide you into all truth.", a: "John 16:13" },
    { q: "For as many as are led by the Spirit of God, they are the sons of God.", a: "Romans 8:14" },
    { q: "And thine ears shall hear a word behind thee, saying, This is the way, walk ye in it, when ye turn to the right hand, and when ye turn to the left.", a: "Isaiah 30:21" },
    { q: "The LORD of hosts hath purposed, and who shall disannul it? and his hand is stretched out, and who shall turn it back?", a: "Isaiah 14:27" },
    { q: "Shew me thy ways, O LORD; teach me thy paths.", a: "Psalm 25:4" },
    { q: "Lead me in thy truth, and teach me: for thou art the God of my salvation; on thee do I wait all the day.", a: "Psalm 25:5" },
    { q: "The meek will he guide in judgment: and the meek will he teach his way.", a: "Psalm 25:9" },
];
function getQuote() {
    const pick = BIBLE_QUOTES[Math.floor(Math.random() * BIBLE_QUOTES.length)];
    return `💬 <i>"${pick.q}"</i>\n— ${pick.a}`;
}
const BIBLE = [
    // Old Testament (39 books)
    { name: "Genesis", chapters: 50, t: "OT" },
    { name: "Exodus", chapters: 40, t: "OT" },
    { name: "Leviticus", chapters: 27, t: "OT" },
    { name: "Numbers", chapters: 36, t: "OT" },
    { name: "Deuteronomy", chapters: 34, t: "OT" },
    { name: "Joshua", chapters: 24, t: "OT" },
    { name: "Judges", chapters: 21, t: "OT" },
    { name: "Ruth", chapters: 4, t: "OT" },
    { name: "1 Samuel", chapters: 31, t: "OT" },
    { name: "2 Samuel", chapters: 24, t: "OT" },
    { name: "1 Kings", chapters: 22, t: "OT" },
    { name: "2 Kings", chapters: 25, t: "OT" },
    { name: "1 Chronicles", chapters: 29, t: "OT" },
    { name: "2 Chronicles", chapters: 36, t: "OT" },
    { name: "Ezra", chapters: 10, t: "OT" },
    { name: "Nehemiah", chapters: 13, t: "OT" },
    { name: "Esther", chapters: 10, t: "OT" },
    { name: "Job", chapters: 42, t: "OT" },
    { name: "Psalms", chapters: 150, t: "OT" },
    { name: "Proverbs", chapters: 31, t: "OT" },
    { name: "Ecclesiastes", chapters: 12, t: "OT" },
    { name: "Song of Solomon", chapters: 8, t: "OT" },
    { name: "Isaiah", chapters: 66, t: "OT" },
    { name: "Jeremiah", chapters: 52, t: "OT" },
    { name: "Lamentations", chapters: 5, t: "OT" },
    { name: "Ezekiel", chapters: 48, t: "OT" },
    { name: "Daniel", chapters: 12, t: "OT" },
    { name: "Hosea", chapters: 14, t: "OT" },
    { name: "Joel", chapters: 3, t: "OT" },
    { name: "Amos", chapters: 9, t: "OT" },
    { name: "Obadiah", chapters: 1, t: "OT" },
    { name: "Jonah", chapters: 4, t: "OT" },
    { name: "Micah", chapters: 7, t: "OT" },
    { name: "Nahum", chapters: 3, t: "OT" },
    { name: "Habakkuk", chapters: 3, t: "OT" },
    { name: "Zephaniah", chapters: 3, t: "OT" },
    { name: "Haggai", chapters: 2, t: "OT" },
    { name: "Zechariah", chapters: 14, t: "OT" },
    { name: "Malachi", chapters: 4, t: "OT" },
    // New Testament (27 books)
    { name: "Matthew", chapters: 28, t: "NT" },
    { name: "Mark", chapters: 16, t: "NT" },
    { name: "Luke", chapters: 24, t: "NT" },
    { name: "John", chapters: 21, t: "NT" },
    { name: "Acts", chapters: 28, t: "NT" },
    { name: "Romans", chapters: 16, t: "NT" },
    { name: "1 Corinthians", chapters: 16, t: "NT" },
    { name: "2 Corinthians", chapters: 13, t: "NT" },
    { name: "Galatians", chapters: 6, t: "NT" },
    { name: "Ephesians", chapters: 6, t: "NT" },
    { name: "Philippians", chapters: 4, t: "NT" },
    { name: "Colossians", chapters: 4, t: "NT" },
    { name: "1 Thessalonians", chapters: 5, t: "NT" },
    { name: "2 Thessalonians", chapters: 3, t: "NT" },
    { name: "1 Timothy", chapters: 6, t: "NT" },
    { name: "2 Timothy", chapters: 4, t: "NT" },
    { name: "Titus", chapters: 3, t: "NT" },
    { name: "Philemon", chapters: 1, t: "NT" },
    { name: "Hebrews", chapters: 13, t: "NT" },
    { name: "James", chapters: 5, t: "NT" },
    { name: "1 Peter", chapters: 5, t: "NT" },
    { name: "2 Peter", chapters: 3, t: "NT" },
    { name: "1 John", chapters: 5, t: "NT" },
    { name: "2 John", chapters: 1, t: "NT" },
    { name: "3 John", chapters: 1, t: "NT" },
    { name: "Jude", chapters: 1, t: "NT" },
    { name: "Revelation", chapters: 22, t: "NT" },
];
function buildChapterList(bookOrder) {
    const list = [];
    for (const idx of bookOrder) {
        const book = BIBLE[idx];
        for (let c = 1; c <= book.chapters; c++) {
            list.push({ book: book.name, chapter: c });
        }
    }
    return list;
}
function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        const j = Math.abs(s) % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function buildBookOrder(mode, seed) {
    const otIdx = BIBLE.map((_, i) => i).filter(i => BIBLE[i].t === "OT");
    const ntIdx = BIBLE.map((_, i) => i).filter(i => BIBLE[i].t === "NT");
    const all = BIBLE.map((_, i) => i);
    switch (mode) {
        case "direct": return all;
        case "alternating": {
            const result = [];
            const maxLen = Math.max(otIdx.length, ntIdx.length);
            for (let i = 0; i < maxLen; i++) {
                if (i < otIdx.length)
                    result.push(otIdx[i]);
                if (i < ntIdx.length)
                    result.push(ntIdx[i]);
            }
            return result;
        }
        case "random": return seededShuffle(all, seed);
        case "random_alternating": {
            const sOT = seededShuffle(otIdx, seed);
            const sNT = seededShuffle(ntIdx, seed + 1);
            const result = [];
            const maxLen = Math.max(sOT.length, sNT.length);
            for (let i = 0; i < maxLen; i++) {
                if (i < sOT.length)
                    result.push(sOT[i]);
                if (i < sNT.length)
                    result.push(sNT[i]);
            }
            return result;
        }
        default: return all;
    }
}
// ═══════════════════════════════════════════════════════════════
// CHAPTERS-READ SIMULATOR
// Walks the plan day-by-day, applying the same catch-up math that
// getTodayReading() uses, so completed catch-up days credit the
// *actual* number of chapters consumed — not just baseDailyQuota.
// This fixes the bug where "days remaining" stayed inflated after
// a user caught up.
// ═══════════════════════════════════════════════════════════════
function simulateChaptersRead(planDays, baseDailyQuota, completedSet, upToDayExclusive) {
    let chaptersRead = 0;
    for (let d = 1; d < upToDayExclusive; d++) {
        const daysRemaining = Math.max(1, planDays - (d - 1));
        const chaptersLeft = Math.max(0, TOTAL_CH - chaptersRead);
        let quota = Math.ceil(chaptersLeft / daysRemaining);
        quota = Math.min(quota, baseDailyQuota * 2);
        if (completedSet.has(d)) {
            chaptersRead = Math.min(TOTAL_CH, chaptersRead + quota);
        }
    }
    return chaptersRead;
}
function getTodayReading(user) {
    const start = new Date(user.start_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    start.setHours(0, 0, 0, 0);
    const daysPassed = Math.floor((today.getTime() - start.getTime()) / 86400000);
    const dayNumber = daysPassed + 1;
    const completedSet = new Set(user.completed_days || []);
    const baseDailyQuota = Math.ceil(TOTAL_CH / user.plan_days);
    const bookOrder = user.book_order && user.book_order.length > 0
        ? user.book_order
        : buildBookOrder(user.reading_mode || "direct", user.user_id);
    const allChapters = buildChapterList(bookOrder);
    // Use the simulator so catch-up days credit their full quota
    const chaptersRead = simulateChaptersRead(user.plan_days, baseDailyQuota, completedSet, dayNumber);
    const chaptersLeft = TOTAL_CH - chaptersRead;
    const daysRemaining = Math.max(1, user.plan_days - daysPassed);
    const missedDays = Math.max(0, daysPassed - completedSet.size);
    let todayQuota = Math.ceil(chaptersLeft / daysRemaining);
    const isCatchUp = todayQuota > baseDailyQuota;
    todayQuota = Math.min(todayQuota, baseDailyQuota * 2);
    const startIdx = Math.min(chaptersRead, allChapters.length);
    const chapters = allChapters.slice(startIdx, startIdx + todayQuota);
    return {
        dayNumber, chapters, isCatchUp, missedDays,
        baseDailyQuota, daysRemaining, chaptersLeft, chaptersRead,
    };
}
// ═══════════════════════════════════════════════════════════════
// STREAK CALCULATOR
// ═══════════════════════════════════════════════════════════════
function calcStreak(completedDays, startDate) {
    if (!completedDays || completedDays.length === 0)
        return 0;
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayNum = Math.floor((today.getTime() - start.getTime()) / 86400000) + 1;
    const set = new Set(completedDays);
    let current = set.has(todayNum) ? todayNum : todayNum - 1;
    if (!set.has(current))
        return 0;
    let streak = 0;
    while (set.has(current) && current >= 1) {
        streak++;
        current--;
    }
    return streak;
}
// ═══════════════════════════════════════════════════════════════
// FORMATTING HELPERS
// ═══════════════════════════════════════════════════════════════
function formatChapters(chapters) {
    if (chapters.length === 0)
        return "No chapters assigned.";
    const groups = [];
    for (const ch of chapters) {
        const last = groups[groups.length - 1];
        if (last && last.book === ch.book && ch.chapter === last.end + 1) {
            last.end = ch.chapter;
        }
        else {
            groups.push({ book: ch.book, start: ch.chapter, end: ch.chapter });
        }
    }
    return groups.map(g => g.start === g.end
        ? `📖 ${g.book} ${g.start}`
        : `📖 ${g.book} ${g.start}–${g.end}`).join("\n");
}
function todayLabel() {
    return new Date().toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
}
function modeLabel(mode) {
    const map = {
        direct: "📖 Direct (Genesis → Revelation)",
        alternating: "🔀 Alternating (OT ↔ NT)",
        random: "🎲 Random",
        random_alternating: "🎲 Random Alternating",
    };
    return map[mode] || mode;
}
function progressBar(pct, length = 10) {
    const filled = Math.round((pct / 100) * length);
    return "█".repeat(filled) + "░".repeat(length - filled);
}
// ═══════════════════════════════════════════════════════════════
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════════
function tgUrl(env, method) {
    return `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
}
async function tgPost(env, method, body) {
    return fetch(tgUrl(env, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
async function sendMessage(env, chatId, text, replyMarkup) {
    await tgPost(env, "sendMessage", {
        chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup,
    });
}
async function editMessage(env, chatId, msgId, text, replyMarkup) {
    await tgPost(env, "editMessageText", {
        chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: replyMarkup,
    });
}
async function answerCallback(env, callbackId, text) {
    await tgPost(env, "answerCallbackQuery", { callback_query_id: callbackId, text });
}
// ═══════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════
// ── MAIN MENU ────────────────────────────────────────────────
function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "📖 Today's Reading", callback_data: "cmd_today" }],
            [
                { text: "📊 Progress", callback_data: "cmd_progress" },
                { text: "📅 Schedule", callback_data: "cmd_schedule" },
            ],
            [{ text: "⚙️ Settings", callback_data: "cmd_settings" }],
        ],
    };
}
async function handleMenu(env, chatId, msgId) {
    const quote = getQuote();
    let text = `🕊️ <b>Scriptura</b> — MOTIONSALT\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    text += `${quote}\n\n`;
    text += `📢 <a href="${CHANNEL}">Join the MOTIONSALT community</a>`;
    msgId
        ? await editMessage(env, chatId, msgId, text, mainMenuKeyboard())
        : await sendMessage(env, chatId, text, mainMenuKeyboard());
}
// ── TODAY ─────────────────────────────────────────────────────
async function handleToday(env, chatId, msgId) {
    const user = await getUser(env, chatId);
    if (!user) {
        await sendMessage(env, chatId, "👋 Type /start to set up your reading plan.");
        return;
    }
    const todayStr = new Date().toISOString().split("T")[0];
    const reading = getTodayReading(user);
    const streak = calcStreak(user.completed_days || [], user.start_date);
    const alreadyDone = user.last_read_date === todayStr;
    const quote = getQuote();
    if (alreadyDone) {
        let text = `✅ <b>All done for today!</b>\n`;
        text += `━━━━━━━━━━━━━━━━━\n\n`;
        if (streak > 0)
            text += `🔥 Streak: <b>${streak} day${streak > 1 ? "s" : ""}</b>\n\n`;
        text += `${quote}\n\n`;
        text += `<i>Come back tomorrow and keep going 💪</i>`;
        const kb = {
            inline_keyboard: [
                [{ text: "📊 Progress", callback_data: "cmd_progress" }],
                [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
            ],
        };
        msgId
            ? await editMessage(env, chatId, msgId, text, kb)
            : await sendMessage(env, chatId, text, kb);
        return;
    }
    let text = `📖 <b>Today's Reading</b>\n`;
    text += `<i>${todayLabel()}</i>\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    if (streak > 0)
        text += `🔥 Streak: <b>${streak} day${streak > 1 ? "s" : ""}</b>\n`;
    text += `📅 Day <b>${reading.dayNumber}</b> of <b>${user.plan_days}</b>\n`;
    text += `⏱️ Est. time: ~<b>${reading.chapters.length * 2} min</b>\n\n`;
    if (reading.isCatchUp && reading.missedDays > 0) {
        text += `⚠️ <b>Catch-up Mode</b>\n`;
        text += `You're ${reading.missedDays} day${reading.missedDays > 1 ? "s" : ""} behind. `;
        text += `Extra chapters added to keep your end date on track.\n\n`;
    }
    text += `<b>Chapters for today:</b>\n`;
    text += formatChapters(reading.chapters);
    text += `\n\n${quote}`;
    const kb = {
        inline_keyboard: [
            [{ text: "✅ Mark Today as Complete", callback_data: "mark_complete" }],
            [
                { text: "📊 Progress", callback_data: "cmd_progress" },
                { text: "📅 Schedule", callback_data: "cmd_schedule" },
            ],
            [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
        ],
    };
    msgId
        ? await editMessage(env, chatId, msgId, text, kb)
        : await sendMessage(env, chatId, text, kb);
}
// ── MARK COMPLETE ─────────────────────────────────────────────
async function handleMarkComplete(env, chatId, msgId) {
    const user = await getUser(env, chatId);
    if (!user)
        return;
    const todayStr = new Date().toISOString().split("T")[0];
    if (user.last_read_date === todayStr)
        return;
    const reading = getTodayReading(user);
    const start = new Date(user.start_date);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayNum = Math.floor((today.getTime() - start.getTime()) / 86400000) + 1;
    const newCompleted = [...(user.completed_days || []), dayNum];
    const newStreak = calcStreak(newCompleted, user.start_date);
    // Use simulator so the % reflects actual chapters read (incl. catch-up)
    const completedSet = new Set(newCompleted);
    const chapsDone = simulateChaptersRead(user.plan_days, reading.baseDailyQuota, completedSet, dayNum + 1);
    const pct = (chapsDone / TOTAL_CH) * 100;
    await env.DB
        .prepare("UPDATE scriptura_progress SET completed_days = ?, last_read_date = ?, streak = ? WHERE user_id = ?")
        .bind(JSON.stringify(newCompleted), todayStr, newStreak, chatId)
        .run();
    // Animated celebration burst
    await sendMessage(env, chatId, "🎉");
    const quote = getQuote();
    let text = `✅ <b>Day ${dayNum} Complete!</b>\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    text += `🔥 Streak: <b>${newStreak} day${newStreak > 1 ? "s" : ""}</b>\n`;
    text += `📈 Overall: <b>${pct.toFixed(1)}%</b> through the Bible\n`;
    text += `${progressBar(pct)} ${pct.toFixed(1)}%\n\n`;
    text += `${quote}`;
    await editMessage(env, chatId, msgId, text, {
        inline_keyboard: [
            [{ text: "📊 Progress", callback_data: "cmd_progress" }],
            [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
        ],
    });
}
// ── PROGRESS ──────────────────────────────────────────────────
async function handleProgress(env, chatId, msgId) {
    const user = await getUser(env, chatId);
    if (!user) {
        await sendMessage(env, chatId, "👋 Type /start first.");
        return;
    }
    const reading = getTodayReading(user);
    const chapsDone = reading.chaptersRead;
    // Properly count OT vs NT by walking the actual book order
    // instead of assuming OT always comes first (breaks in non-direct modes)
    const bookOrder = user.book_order && user.book_order.length > 0
        ? user.book_order
        : buildBookOrder(user.reading_mode || "direct", user.user_id);
    const allChapters = buildChapterList(bookOrder);
    // Build a fast name → testament lookup map
    const testamentMap = new Map();
    for (const book of BIBLE)
        testamentMap.set(book.name, book.t);
    let chapsDoneOT = 0;
    let chapsDoneNT = 0;
    for (let i = 0; i < Math.min(chapsDone, allChapters.length); i++) {
        if (testamentMap.get(allChapters[i].book) === "NT") {
            chapsDoneNT++;
        }
        else {
            chapsDoneOT++;
        }
    }
    const pct = (chapsDone / TOTAL_CH) * 100;
    const pctOT = (chapsDoneOT / 929) * 100;
    const pctNT = (chapsDoneNT / 260) * 100;
    const streak = calcStreak(user.completed_days || [], user.start_date);
    const start = new Date(user.start_date);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysPassed = Math.floor((today.getTime() - start.getTime()) / 86400000);
    // FIX: account for catch-up. After catching up, the user is effectively
    // further along than calendar days suggest, so "days remaining" should
    // reflect the actual chapters left at base pace, not just plan_days - daysPassed.
    const calendarRemaining = Math.max(0, user.plan_days - daysPassed);
    const paceRemaining = Math.ceil((TOTAL_CH - chapsDone) / reading.baseDailyQuota);
    const daysRemaining = Math.min(calendarRemaining, Math.max(0, paceRemaining));
    const milestones = [
        { label: "🌱 First Steps", threshold: 10 },
        { label: "⚡ Quarter Done", threshold: 25 },
        { label: "🏅 Halfway", threshold: 50 },
        { label: "🔥 Almost There", threshold: 75 },
        { label: "👑 Complete", threshold: 100 },
    ];
    let text = `📊 <b>Reading Progress</b>\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    text += `📖 <b>Overall</b>\n`;
    text += `${progressBar(pct)} <b>${pct.toFixed(1)}%</b>\n`;
    text += `${chapsDone} / ${TOTAL_CH} chapters\n\n`;
    text += `📜 <b>Old Testament</b>\n`;
    text += `${progressBar(pctOT)} ${pctOT.toFixed(1)}%\n`;
    text += `${chapsDoneOT} / 929 chapters\n\n`;
    text += `✝️ <b>New Testament</b>\n`;
    text += `${progressBar(pctNT)} ${pctNT.toFixed(1)}%\n`;
    text += `${chapsDoneNT} / 260 chapters\n\n`;
    text += `🔥 Streak: <b>${streak} day${streak !== 1 ? "s" : ""}</b>\n`;
    text += `📅 Days remaining: <b>${daysRemaining}</b>\n\n`;
    text += `🏆 <b>Milestones</b>\n`;
    for (const m of milestones) {
        text += pct >= m.threshold ? `${m.label} ✅\n` : `${m.label} 🔒\n`;
    }
    const kb = {
        inline_keyboard: [
            [{ text: "📖 Today's Reading", callback_data: "cmd_today" }],
            [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
        ],
    };
    msgId
        ? await editMessage(env, chatId, msgId, text, kb)
        : await sendMessage(env, chatId, text, kb);
}
// ── SCHEDULE ──────────────────────────────────────────────────
async function handleSchedule(env, chatId, msgId, page = 0) {
    const user = await getUser(env, chatId);
    if (!user) {
        await sendMessage(env, chatId, "👋 Type /start first.");
        return;
    }
    const start = new Date(user.start_date);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysPassed = Math.floor((today.getTime() - start.getTime()) / 86400000);
    const todayDayNum = daysPassed + 1;
    const completedSet = new Set(user.completed_days || []);
    const baseDailyQuota = Math.ceil(TOTAL_CH / user.plan_days);
    const bookOrder = user.book_order && user.book_order.length > 0
        ? user.book_order
        : buildBookOrder(user.reading_mode, user.user_id);
    const allChapters = buildChapterList(bookOrder);
    const PAGE_SIZE = 7;
    const startDay = Math.max(1, todayDayNum - 3 + page * PAGE_SIZE);
    const endDay = Math.min(user.plan_days, startDay + PAGE_SIZE - 1);
    let text = `📅 <b>Reading Schedule</b>\n`;
    text += `${user.plan_days} days · ${modeLabel(user.reading_mode)}\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    for (let d = startDay; d <= endDay; d++) {
        const chStart = (d - 1) * baseDailyQuota;
        const dayChapters = allChapters.slice(chStart, chStart + baseDailyQuota);
        const done = completedSet.has(d);
        const isToday = d === todayDayNum;
        const dayDate = new Date(user.start_date);
        dayDate.setDate(dayDate.getDate() + d - 1);
        const dateStr = dayDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const first = dayChapters[0]?.book || "—";
        const last = dayChapters[dayChapters.length - 1]?.book || first;
        const chLabel = first === last ? first : `${first} → ${last}`;
        const marker = done ? "✅" : isToday ? "👉" : "⬜";
        text += `${marker} <b>Day ${d}</b>${isToday ? " · <b>TODAY</b>" : ""}  <i>${dateStr}</i>\n`;
        text += `    ${chLabel}\n\n`;
    }
    const navRow = [];
    if (startDay > 1)
        navRow.push({ text: "⬅️ Prev", callback_data: `sched_${page - 1}` });
    if (endDay < user.plan_days)
        navRow.push({ text: "Next ➡️", callback_data: `sched_${page + 1}` });
    const kb = { inline_keyboard: [] };
    if (navRow.length > 0)
        kb.inline_keyboard.push(navRow);
    kb.inline_keyboard.push([{ text: "🏠 Main Menu", callback_data: "cmd_menu" }]);
    msgId
        ? await editMessage(env, chatId, msgId, text, kb)
        : await sendMessage(env, chatId, text, kb);
}
// ── SETTINGS ─────────────────────────────────────────────────
async function handleSettings(env, chatId, msgId) {
    const user = await getUser(env, chatId);
    if (!user) {
        await sendMessage(env, chatId, "👋 Type /start first.");
        return;
    }
    // Lock settings if user has an active plan
    const start = new Date(user.start_date);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysPassed = Math.floor((today.getTime() - start.getTime()) / 86400000);
    const hasActivePlan = daysPassed > 0 || (user.completed_days || []).length > 0;
    if (hasActivePlan) {
        const text = `⚙️ <b>Settings Locked</b>\n` +
            `━━━━━━━━━━━━━━━━━\n\n` +
            `🔒 You have an active reading plan in progress.\n\n` +
            `To change your settings, reset your progress first.\n` +
            `⚠️ <i>This will clear all completed days and your streak.</i>`;
        const kb = {
            inline_keyboard: [
                [{ text: "🔄 Reset Progress", callback_data: "confirm_reset" }],
                [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
            ],
        };
        msgId
            ? await editMessage(env, chatId, msgId, text, kb)
            : await sendMessage(env, chatId, text, kb);
        return;
    }
    // No active plan — show full settings
    await env.DB
        .prepare("UPDATE scriptura_progress SET waiting_for = ? WHERE user_id = ?")
        .bind(null, chatId)
        .run();
    let text = `⚙️ <b>Settings</b>\n`;
    text += `━━━━━━━━━━━━━━━━━\n\n`;
    text += `📅 Plan Duration: <b>${user.plan_days} days</b>\n`;
    text += `🔀 Reading Mode: <b>${modeLabel(user.reading_mode)}</b>\n`;
    text += `🗓️ Start Date: <b>${user.start_date}</b>\n\n`;
    text += `Choose your reading mode and plan length below.\n`;
    text += `For any custom number of days tap <b>✏️ Custom Days</b>.`;
    const kb = {
        inline_keyboard: [
            [
                { text: "📖 Direct", callback_data: "mode_direct" },
                { text: "🔀 Alternating", callback_data: "mode_alternating" },
            ],
            [
                { text: "🎲 Random", callback_data: "mode_random" },
                { text: "🎲 Rnd. Alt.", callback_data: "mode_random_alternating" },
            ],
            [
                { text: "30 days", callback_data: "days_30" },
                { text: "60 days", callback_data: "days_60" },
                { text: "90 days", callback_data: "days_90" },
            ],
            [
                { text: "120 days", callback_data: "days_120" },
                { text: "180 days", callback_data: "days_180" },
                { text: "365 days", callback_data: "days_365" },
            ],
            [{ text: "✏️ Custom Days", callback_data: "days_custom" }],
            [{ text: "🔄 Reset All Progress", callback_data: "confirm_reset" }],
            [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
        ],
    };
    msgId
        ? await editMessage(env, chatId, msgId, text, kb)
        : await sendMessage(env, chatId, text, kb);
}
// ── RESET CONFIRMATION ────────────────────────────────────────
async function handleConfirmReset(env, chatId, msgId) {
    await editMessage(env, chatId, msgId, `🔄 <b>Reset All Progress?</b>\n\n` +
        `⚠️ This will erase:\n` +
        `• All completed days ✅\n` +
        `• Your reading streak 🔥\n` +
        `• Your plan settings ⚙️\n\n` +
        `<i>This cannot be undone.</i>`, {
        inline_keyboard: [
            [
                { text: "✅ Yes, Reset", callback_data: "do_reset" },
                { text: "❌ Cancel", callback_data: "cmd_settings" },
            ],
        ],
    });
}
async function handleDoReset(env, chatId, msgId) {
    const todayStr = new Date().toISOString().split("T")[0];
    await env.DB
        .prepare(`UPDATE scriptura_progress
              SET completed_days = ?, streak = ?, last_read_date = ?, start_date = ?, waiting_for = ?
              WHERE user_id = ?`)
        .bind(JSON.stringify([]), 0, null, todayStr, null, chatId)
        .run();
    await editMessage(env, chatId, msgId, `✅ <b>Progress Reset!</b>\n\n` +
        `🗓️ Your plan starts fresh from today.\n` +
        `Go to ⚙️ Settings to configure your new plan.`, {
        inline_keyboard: [
            [{ text: "⚙️ Settings", callback_data: "cmd_settings" }],
            [{ text: "🏠 Main Menu", callback_data: "cmd_menu" }],
        ],
    });
}
// ═══════════════════════════════════════════════════════════════
// ROUTER — the ORIGINAL dispatch logic, unchanged, extracted into a
// dedicated function so the channel-follow gate can wrap the entire
// update pipeline in one place rather than being duplicated across
// every command / callback handler.
// ═══════════════════════════════════════════════════════════════
async function dispatchUpdate(env, update) {
    try {
        // ── Text messages ─────────────────────────────────────────
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const firstName = update.message.from?.first_name || "friend";
            // ── Custom days input interception ─────────────────────
            if (!text.startsWith("/")) {
                const row = await env.DB
                    .prepare("SELECT waiting_for FROM scriptura_progress WHERE user_id = ?")
                    .bind(chatId)
                    .first();
                if (row?.waiting_for === "custom_days") {
                    const num = parseInt(text.replace(/[^0-9]/g, ""), 10);
                    if (isNaN(num) || num < 1 || num > 3650) {
                        await sendMessage(env, chatId, `⚠️ Please send a number between 1 and 3650.\n\nExample: <code>120</code>`, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cmd_settings" }]] });
                    }
                    else {
                        await env.DB
                            .prepare("UPDATE scriptura_progress SET plan_days = ?, waiting_for = ? WHERE user_id = ?")
                            .bind(num, null, chatId)
                            .run();
                        await sendMessage(env, chatId, `✅ Plan set to <b>${num} days</b>. 🎯\n\nYour schedule has been updated!`, { inline_keyboard: [[{ text: "⚙️ Back to Settings", callback_data: "cmd_settings" }]] });
                    }
                    return;
                }
            }
            // ── Slash commands ─────────────────────────────────────
            if (text === "/start") {
                const existing = await env.DB
                    .prepare("SELECT user_id FROM scriptura_progress WHERE user_id = ?")
                    .bind(chatId)
                    .first();
                if (!existing) {
                    const bookOrder = buildBookOrder("direct", chatId);
                    const startDate = new Date().toISOString().split("T")[0];
                    await env.DB
                        .prepare(`INSERT INTO scriptura_progress
                (user_id, start_date, completed_days, book_order, plan_days, reading_mode, streak, waiting_for)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                        .bind(chatId, startDate, JSON.stringify([]), JSON.stringify(bookOrder), 365, "direct", 0, null)
                        .run();
                }
                const quote = getQuote();
                let welcome = `🕊️ <b>Welcome${existing ? " back" : ""}, ${firstName}!</b>\n`;
                welcome += `━━━━━━━━━━━━━━━━━\n\n`;
                welcome += `<b>Scriptura</b> — Your daily Bible reading companion 📖\n`;
                welcome += `By MOTIONSALT\n\n`;
                welcome += `${quote}\n\n`;
                welcome += `📢 <a href="${CHANNEL}">Join the MOTIONSALT community</a>`;
                await sendMessage(env, chatId, welcome, mainMenuKeyboard());
                return;
            }
            if (text === "/today") {
                await handleToday(env, chatId);
                return;
            }
            if (text === "/progress") {
                await handleProgress(env, chatId);
                return;
            }
            if (text === "/schedule") {
                await handleSchedule(env, chatId);
                return;
            }
            if (text === "/settings") {
                await handleSettings(env, chatId);
                return;
            }
            if (text === "/menu") {
                await handleMenu(env, chatId);
                return;
            }
        }
        // ── Inline button callbacks ───────────────────────────────
        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const msgId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            const cbId = update.callback_query.id;
            await answerCallback(env, cbId);
            if (data === "cmd_menu") {
                await handleMenu(env, chatId, msgId);
            }
            else if (data === "cmd_today") {
                await handleToday(env, chatId, msgId);
            }
            else if (data === "mark_complete") {
                await handleMarkComplete(env, chatId, msgId);
            }
            else if (data === "cmd_progress") {
                await handleProgress(env, chatId, msgId);
            }
            else if (data === "cmd_settings") {
                await handleSettings(env, chatId, msgId);
            }
            else if (data === "cmd_schedule") {
                await handleSchedule(env, chatId, msgId, 0);
            }
            else if (data === "confirm_reset") {
                await handleConfirmReset(env, chatId, msgId);
            }
            else if (data === "do_reset") {
                await handleDoReset(env, chatId, msgId);
            }
            else if (data.startsWith("sched_")) {
                const page = parseInt(data.split("_")[1]) || 0;
                await handleSchedule(env, chatId, msgId, page);
            }
            else if (data.startsWith("mode_")) {
                const mode = data.replace("mode_", "");
                const bookOrder = buildBookOrder(mode, chatId);
                await env.DB
                    .prepare("UPDATE scriptura_progress SET reading_mode = ?, book_order = ? WHERE user_id = ?")
                    .bind(mode, JSON.stringify(bookOrder), chatId)
                    .run();
                await handleSettings(env, chatId, msgId);
            }
            else if (data.startsWith("days_")) {
                const val = data.replace("days_", "");
                if (val === "custom") {
                    await env.DB
                        .prepare("UPDATE scriptura_progress SET waiting_for = ? WHERE user_id = ?")
                        .bind("custom_days", chatId)
                        .run();
                    await editMessage(env, chatId, msgId, `✏️ <b>Custom Plan Length</b>\n\n` +
                        `Reply with the number of days for your reading plan.\n\n` +
                        `Example: <code>120</code>\n\n` +
                        `Any number from 1 to 3650 works. 🎯`, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cmd_settings" }]] });
                }
                else {
                    const days = parseInt(val);
                    await env.DB
                        .prepare("UPDATE scriptura_progress SET plan_days = ?, waiting_for = ? WHERE user_id = ?")
                        .bind(days, null, chatId)
                        .run();
                    await handleSettings(env, chatId, msgId);
                }
            }
        }
    }
    catch (err) {
        console.error("Handler error:", err);
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// The channel-follow gate wraps the ENTIRE original router — every
// command, every button callback goes through the membership check
// first. This is an additive wrapper; the original dispatch logic in
// dispatchUpdate() is untouched.
// ═══════════════════════════════════════════════════════════════
export default {
    async fetch(request, env, _ctx) {
        if (request.method !== "POST") {
            return new Response("Scriptura webhook OK", { status: 200 });
        }
        try {
            const update = await request.json();

            // ── Channel-follow gate ───────────────────────────────────
            // Runs BEFORE any other routing. Extract the acting user, check
            // their @motionsalt membership (KV-cached), and if they're not
            // a member — or the check errors — reply with the gate message
            // and stop. Silently drop updates that have no user attached.
            const userId = extractUserId(update);
            const chatId = extractChatId(update);
            if (!userId || !chatId) {
                return new Response("OK");
            }

            // Special-case the "I've Joined — Check Again" button: it must
            // re-run the check, and on success proceed straight to the
            // /start welcome flow. On failure, re-show the gate. Either
            // way, this callback is fully handled here and never reaches
            // the main dispatcher.
            if (update.callback_query?.data === "check_membership") {
                await answerCallback(env, update.callback_query.id, "");
                const nowMember = await checkMembership(env, userId);
                if (nowMember) {
                    // Synthesize a /start message so the user lands on the
                    // normal welcome screen rather than getting no response.
                    await dispatchUpdate(env, {
                        message: {
                            text: "/start",
                            chat: { id: chatId },
                            from: update.callback_query.from,
                        },
                    });
                }
                else {
                    await sendGateMessage(env, chatId);
                }
                return new Response("OK");
            }

            const isMember = await checkMembership(env, userId);
            if (!isMember) {
                // Acknowledge callback taps so the Telegram spinner clears,
                // even though we're blocking the underlying action.
                if (update.callback_query?.id) {
                    await answerCallback(env, update.callback_query.id, "🔒 Join @motionsalt first");
                }
                await sendGateMessage(env, chatId);
                return new Response("OK");
            }

            // Gate cleared — hand off to the ORIGINAL router.
            await dispatchUpdate(env, update);
        }
        catch (err) {
            console.error("Handler error:", err);
        }
        return new Response("OK");
    },
};
