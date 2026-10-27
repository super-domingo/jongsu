"use strict";

/* ---------- 저장소 (이 휴대폰에만 저장) ---------- */
const STORE_KEY = "jongsu-english-v1";
const DEFAULT_STATE = {
  cards: {},        // 단어별 복습 상태 { box, due, right, wrong }
  phrasesDone: {},  // 들어본/말해본 표현
  days: {},         // 날짜별 활동 { words, phrases, quiz, talk, speak }
  quizzes: [],      // { date, score, total }
  grammar: {},      // 문법 레슨별 { best, total }
  speech: { tries: 0, good: 0 },
  settings: { rate: 0.85, apiKey: "", name: "" },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = JSON.parse(raw);
    return { ...structuredClone(DEFAULT_STATE), ...s, settings: { ...DEFAULT_STATE.settings, ...(s.settings || {}) } };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
let state = loadState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* 저장 불가 환경 */ }
}

/* ---------- 날짜·스트릭 ---------- */
function dayKey(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function logActivity(kind, n = 1) {
  const k = dayKey();
  const day = state.days[k] || (state.days[k] = { words: 0, phrases: 0, quiz: 0, talk: 0, speak: 0, grammar: 0 });
  day[kind] = (day[kind] || 0) + n;
  save();
}
function activeOn(d) {
  const day = state.days[dayKey(d)];
  return !!day && Object.values(day).some((v) => v > 0);
}
function streak() {
  let d = new Date();
  if (!activeOn(d)) d = addDays(d, -1); // 오늘 아직 안 했으면 어제까지 이어진 기록
  let n = 0;
  while (activeOn(d)) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak() {
  const keys = Object.keys(state.days).filter((k) => activeOn(new Date(k + "T12:00"))).sort();
  let best = 0, cur = 0, prev = null;
  for (const k of keys) {
    const d = new Date(k + "T12:00");
    cur = prev && dayKey(addDays(prev, 1)) === k ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  return best;
}

/* ---------- 단어 복습 (라이트너 상자) ---------- */
const INTERVALS = [0, 1, 2, 4, 7, 15]; // 상자별 다음 복습까지 일수
const wordKey = (w) => w[0];
function cardOf(w) { return state.cards[wordKey(w)]; }
function isLearned(w) { const c = cardOf(w); return c && c.box >= 3; }
function isDue(w) { const c = cardOf(w); return !c || c.due <= dayKey(); }
function grade(w, known) {
  const c = state.cards[wordKey(w)] || { box: 0, due: dayKey(), right: 0, wrong: 0 };
  if (known) { c.box = Math.min(c.box + 1, INTERVALS.length - 1); c.right++; }
  else { c.box = 0; c.wrong++; }
  c.due = dayKey(addDays(new Date(), INTERVALS[c.box]));
  state.cards[wordKey(w)] = c;
  logActivity("words");
}
const ALL_WORDS = WORD_DECKS.flatMap((d) => d.words);
const ALL_PHRASES = PHRASE_SETS.flatMap((s) => s.phrases);
const GRAMMAR = [...GRAMMAR_1, ...GRAMMAR_2];
const grammarDone = (l) => { const g = state.grammar[l.id]; return g && g.best >= Math.ceil(g.total * 0.7); };

/* ---------- 음성: 듣기 ---------- */
let voices = [];
function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
function pickVoice() {
  const pref = ["Samantha", "Google US English", "Karen", "Daniel", "Moira"];
  for (const name of pref) { const v = voices.find((x) => x.name.includes(name)); if (v) return v; }
  return voices.find((v) => v.lang === "en-US") || voices[0];
}
function speak(text, rate) {
  if (!("speechSynthesis" in window)) { toast("이 브라우저는 음성 듣기를 지원하지 않아요"); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v ? v.lang : "en-US";
  u.rate = rate || state.settings.rate;
  speechSynthesis.speak(u);
}

/* ---------- 음성: 따라 말하기 ---------- */
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen() {
  return new Promise((resolve, reject) => {
    if (!Recognition) { reject(new Error("unsupported")); return; }
    const r = new Recognition();
    r.lang = "en-US";
    r.interimResults = false;
    r.maxAlternatives = 3;
    let done = false;
    r.onresult = (e) => {
      done = true;
      resolve(Array.from(e.results[0]).map((a) => a.transcript));
    };
    r.onerror = (e) => { done = true; reject(new Error(e.error || "error")); };
    r.onend = () => { if (!done) reject(new Error("no-speech")); };
    r.start();
  });
}
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
function scoreSpeech(target, alts) {
  const want = norm(target);
  let best = { score: 0, heard: alts[0] || "", hits: [] };
  for (const alt of alts) {
    const got = norm(alt);
    const pool = [...got];
    const hits = want.map((w) => { const i = pool.indexOf(w); if (i >= 0) { pool.splice(i, 1); return true; } return false; });
    const score = Math.round((hits.filter(Boolean).length / want.length) * 100);
    if (score > best.score) best = { score, heard: alt, hits };
  }
  if (!best.hits.length) best.hits = want.map(() => false);
  return best;
}
function speechErrorText(err) {
  const m = err && err.message;
  if (m === "unsupported") return "이 브라우저는 말하기 인식을 지원하지 않아요. 크롬이나 사파리 최신 버전을 써주세요.";
  if (m === "not-allowed" || m === "service-not-allowed") return "마이크 권한을 허용해 주세요.";
  if (m === "no-speech") return "소리가 잘 안 들렸어요. 다시 말해볼까요?";
  return "인식에 실패했어요. 다시 시도해 주세요.";
}

/* ---------- 공통 UI 도우미 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}
function header(title, back) {
  return `<header class="top">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="뒤로">‹</a>` : `<span class="brand">🐳</span>`}
    <h1>${esc(title)}</h1>
    <a class="icon-btn" href="#/settings" aria-label="설정">⚙️</a>
  </header>`;
}
function speakBtn(text, label = "🔊") {
  return `<button class="round-btn" data-say="${esc(text)}" aria-label="듣기">${label}</button>`;
}
function setNav(tab) {
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}

// 문서 전체에서 🔊 버튼 처리
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-say]");
  if (b) { e.preventDefault(); speak(b.dataset.say, b.dataset.slow ? 0.6 : undefined); }
});

/* ---------- 화면: 홈 ---------- */
function viewHome() {
  setNav("home");
  const today = state.days[dayKey()] || {};
  const s = streak();
  const learned = ALL_WORDS.filter(isLearned).length;
  const due = ALL_WORDS.filter((w) => cardOf(w) && isDue(w)).length;
  const hour = new Date().getHours();
  const hi = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "오늘도 수고했어요";
  const name = state.settings.name ? `${esc(state.settings.name)}님, ` : "";
  const todayWord = ALL_WORDS[Math.floor(Date.now() / 864e5) % ALL_WORDS.length];
  const nextGrammar = GRAMMAR.find((l) => !grammarDone(l)) || GRAMMAR[Math.floor(Date.now() / 864e5) % GRAMMAR.length];

  app.innerHTML = `${header("종수영어정복")}
  <main class="page">
    <p class="hello">${name}${hi} ☀️</p>
    <section class="streak-card">
      <div class="flame ${activeOn(new Date()) ? "lit" : ""}">🔥</div>
      <div>
        <div class="big">${s}일 연속</div>
        <div class="sub">${activeOn(new Date()) ? "오늘도 해냈어요! 🎉" : s ? "오늘 한 번만 공부하면 이어져요" : "오늘부터 시작해봐요"}</div>
      </div>
    </section>
    <section class="today-grid">
      <div><b>${today.words || 0}</b><span>단어</span></div>
      <div><b>${today.phrases || 0}</b><span>표현</span></div>
      <div><b>${today.grammar || 0}</b><span>문법</span></div>
      <div><b>${today.quiz || 0}</b><span>퀴즈</span></div>
      <div><b>${today.talk || 0}</b><span>대화</span></div>
    </section>

    <section class="word-of-day card">
      <div class="label">오늘의 단어</div>
      <div class="row"><div><div class="en">${esc(todayWord[0])}</div><div class="ko">${esc(todayWord[1])}</div></div>${speakBtn(todayWord[0])}</div>
      <div class="ex">${esc(todayWord[2])} ${speakBtn(todayWord[2], "▶")}</div>
    </section>

    <a class="grammar-today card" href="#/grammar/${nextGrammar.id}">
      <div class="label">오늘의 문법 · ${nextGrammar.no}강</div>
      <div class="row"><div><b>${esc(nextGrammar.title)}</b><div class="muted small">${esc(nextGrammar.summary)}</div></div><span class="count">›</span></div>
    </a>

    ${due ? `<a class="cta" href="#/review">📚 복습할 단어 ${due}개 <span>›</span></a>` : ""}

    <section class="menu-grid">
      <a href="#/words" class="tile pink"><span>🃏</span>단어 카드</a>
      <a href="#/phrases" class="tile yellow"><span>💬</span>상황별 표현</a>
      <a href="#/quiz" class="tile mint"><span>✏️</span>퀴즈</a>
      <a href="#/talk" class="tile lilac"><span>👩‍🏫</span>선생님 대화</a>
    </section>
    <p class="foot-note">외운 단어 ${learned} / ${ALL_WORDS.length}개 · 끝낸 문법 ${GRAMMAR.filter(grammarDone).length} / ${GRAMMAR.length}강</p>
  </main>`;
}

/* ---------- 화면: 단어 덱 목록 ---------- */
function viewWords() {
  setNav("words");
  app.innerHTML = `${header("단어 카드")}
  <main class="page">
    <p class="hint">카드를 눌러 뜻을 확인하고, 알면 😊 모르면 🤔 를 눌러요. 모르는 단어는 더 자주 나와요.</p>
    <div class="list">
      ${WORD_DECKS.map((d) => {
        const l = d.words.filter(isLearned).length;
        const pct = Math.round((l / d.words.length) * 100);
        return `<a class="list-item" href="#/words/${d.id}">
          <span class="emoji">${d.emoji}</span>
          <span class="grow"><b>${d.title}</b><span class="bar"><i style="width:${pct}%"></i></span></span>
          <span class="count">${l}/${d.words.length}</span>
        </a>`;
      }).join("")}
    </div>
  </main>`;
}

/* ---------- 화면: 플래시카드 ---------- */
function viewCards(deckId, review = false) {
  setNav(review ? "home" : "words");
  let pool, title;
  if (review) {
    pool = ALL_WORDS.filter((w) => cardOf(w) && isDue(w));
    title = "오늘의 복습";
  } else {
    const deck = WORD_DECKS.find((d) => d.id === deckId);
    if (!deck) { location.hash = "#/words"; return; }
    title = `${deck.emoji} ${deck.title}`;
    // 복습할 카드 → 새 카드 → 이미 아는 카드 순서로 10장
    const due = deck.words.filter((w) => cardOf(w) && isDue(w));
    const fresh = deck.words.filter((w) => !cardOf(w));
    const rest = deck.words.filter((w) => cardOf(w) && !isDue(w));
    pool = [...shuffle(due), ...shuffle(fresh), ...shuffle(rest)];
  }
  const queue = pool.slice(0, 10);
  if (!queue.length) {
    app.innerHTML = `${header(title, "#/")}<main class="page center"><div class="done-emoji">🌟</div><p>복습할 단어가 없어요!<br>새 단어를 배워볼까요?</p><a class="btn primary" href="#/words">단어 카드로</a></main>`;
    return;
  }
  const total = queue.length;
  let known = 0, idx = 0;

  function render() {
    if (!queue.length) {
      app.innerHTML = `${header(title, review ? "#/" : "#/words")}
      <main class="page center">
        <div class="done-emoji">🎉</div>
        <h2>잘했어요!</h2>
        <p>${total}개 중 <b>${known}개</b>를 한 번에 알았어요.</p>
        <div class="btn-row">
          <a class="btn" href="${review ? "#/" : "#/words"}">목록으로</a>
          <button class="btn primary" id="again">한 번 더</button>
        </div>
      </main>`;
      $("#again").onclick = () => viewCards(deckId, review);
      return;
    }
    const w = queue[0];
    idx++;
    app.innerHTML = `${header(title, review ? "#/" : "#/words")}
    <main class="page">
      <div class="progress"><i style="width:${Math.round(((total - queue.length) / total) * 100)}%"></i></div>
      <div class="flip" id="flip">
        <div class="flip-inner">
          <div class="face front">
            <div class="en big-word">${esc(w[0])}</div>
            <div class="tap">눌러서 뜻 보기</div>
          </div>
          <div class="face back">
            <div class="en">${esc(w[0])}</div>
            <div class="ko big-ko">${esc(w[1])}</div>
            <div class="ex">${esc(w[2])}</div>
          </div>
        </div>
      </div>
      <div class="btn-row center-row">
        ${speakBtn(w[0])}
        <button class="round-btn" data-say="${esc(w[2])}" aria-label="예문 듣기">▶</button>
      </div>
      <div class="grade-row">
        <button class="btn grade no" id="no">🤔 몰라요</button>
        <button class="btn grade yes" id="yes">😊 알아요</button>
      </div>
    </main>`;
    const flip = $("#flip");
    flip.onclick = () => flip.classList.toggle("flipped");
    setTimeout(() => speak(w[0]), 250);
    $("#yes").onclick = () => { grade(w, true); if (!w._missed) known++; queue.shift(); render(); };
    $("#no").onclick = () => {
      grade(w, false);
      w._missed = true;
      queue.shift();
      queue.splice(Math.min(3, queue.length), 0, w); // 몇 장 뒤에 다시
      render();
    };
  }
  queue.forEach((w) => delete w._missed);
  render();
}

/* ---------- 화면: 상황별 표현 ---------- */
function viewPhrases() {
  setNav("phrases");
  app.innerHTML = `${header("상황별 표현")}
  <main class="page">
    <p class="hint">🔊로 듣고, 🎤를 눌러 따라 말해보세요. 발음 점수를 알려드려요.</p>
    <div class="grid2">
      ${PHRASE_SETS.map((s) => {
        const done = s.phrases.filter((p) => state.phrasesDone[p[0]]).length;
        return `<a class="set-tile" href="#/phrases/${s.id}"><span class="emoji">${s.emoji}</span><b>${s.title}</b><small>${done}/${s.phrases.length}</small></a>`;
      }).join("")}
    </div>
  </main>`;
}

function viewPhraseSet(id) {
  setNav("phrases");
  const set = PHRASE_SETS.find((s) => s.id === id);
  if (!set) { location.hash = "#/phrases"; return; }
  app.innerHTML = `${header(`${set.emoji} ${set.title}`, "#/phrases")}
  <main class="page">
    <div class="list">
      ${set.phrases.map((p, i) => `
        <div class="phrase card" data-i="${i}">
          <div class="en">${esc(p[0])}</div>
          <div class="ko">${esc(p[1])}</div>
          <div class="phrase-actions">
            ${speakBtn(p[0])}
            <button class="round-btn" data-say="${esc(p[0])}" data-slow="1" aria-label="천천히 듣기">🐢</button>
            <button class="round-btn mic" data-mic="${i}" aria-label="따라 말하기">🎤</button>
            ${state.phrasesDone[p[0]] ? `<span class="check">✓</span>` : ""}
          </div>
          <div class="result" id="r${i}"></div>
        </div>`).join("")}
    </div>
  </main>`;

  app.querySelectorAll("[data-say]").forEach((b) => b.addEventListener("click", () => {
    const p = set.phrases[b.closest(".phrase").dataset.i];
    if (!state.phrasesDone[p[0]]) { state.phrasesDone[p[0]] = 1; logActivity("phrases"); }
  }));
  app.querySelectorAll("[data-mic]").forEach((b) => b.addEventListener("click", () => practice(b, set.phrases[b.dataset.mic][0], $(`#r${b.dataset.mic}`))));
}

async function practice(btn, target, out) {
  if (btn.classList.contains("listening")) return;
  speechSynthesis && speechSynthesis.cancel();
  btn.classList.add("listening");
  out.innerHTML = `<span class="muted">듣고 있어요… 말해보세요 🎙️</span>`;
  try {
    const alts = await listen();
    const r = scoreSpeech(target, alts);
    state.speech.tries++;
    if (r.score >= 80) state.speech.good++;
    if (!state.phrasesDone[target]) { state.phrasesDone[target] = 1; logActivity("phrases"); }
    logActivity("speak");
    const words = target.split(/\s+/);
    const msg = r.score >= 90 ? "완벽해요! 🎉" : r.score >= 70 ? "아주 좋아요! 👏" : r.score >= 40 ? "좋아요, 한 번 더! 💪" : "천천히 다시 해볼까요? 🐢";
    out.innerHTML = `<div class="score ${r.score >= 70 ? "good" : "try"}">${r.score}점 · ${msg}</div>
      <div class="words">${words.map((w, i) => `<span class="${r.hits[i] ? "hit" : "miss"}">${esc(w)}</span>`).join(" ")}</div>
      <div class="muted">들린 말: “${esc(r.heard)}”</div>`;
  } catch (err) {
    out.innerHTML = `<span class="muted">${speechErrorText(err)}</span>`;
  } finally {
    btn.classList.remove("listening");
  }
}

/* ---------- 화면: 퀴즈 ---------- */
function viewQuizHome() {
  setNav("home");
  const last = state.quizzes.slice(-1)[0];
  app.innerHTML = `${header("퀴즈", "#/")}
  <main class="page">
    <p class="hint">10문제가 나와요. 뜻 고르기 · 영어 고르기 · 듣고 고르기 · 문장 만들기가 섞여 있어요.</p>
    <div class="list">
      <button class="list-item" data-scope="all"><span class="emoji">🎲</span><span class="grow"><b>전체에서 골고루</b></span><span class="count">›</span></button>
      <button class="list-item" data-scope="learned"><span class="emoji">📚</span><span class="grow"><b>내가 공부한 단어만</b></span><span class="count">›</span></button>
      ${WORD_DECKS.map((d) => `<button class="list-item" data-scope="${d.id}"><span class="emoji">${d.emoji}</span><span class="grow"><b>${d.title}</b></span><span class="count">›</span></button>`).join("")}
    </div>
    ${last ? `<p class="foot-note">지난 퀴즈: ${last.score}/${last.total}점</p>` : ""}
  </main>`;
  app.querySelectorAll("[data-scope]").forEach((b) => (b.onclick = () => runQuiz(b.dataset.scope)));
}

function runQuiz(scope) {
  let words = ALL_WORDS;
  if (scope === "learned") {
    words = ALL_WORDS.filter((w) => cardOf(w));
    if (words.length < 4) { toast("공부한 단어가 4개 이상 있어야 해요. 전체에서 낼게요!"); words = ALL_WORDS; }
  } else if (scope !== "all") {
    words = WORD_DECKS.find((d) => d.id === scope).words;
  }
  const kinds = ["en2ko", "ko2en", "listen", "order"];
  const qs = shuffle(words).slice(0, 10).map((w, i) => ({ w, kind: kinds[i % 4] }));
  shuffle(qs);
  let i = 0, score = 0;
  const wrongs = [];

  function options(w, field) {
    const others = shuffle(ALL_WORDS.filter((x) => x[field] !== w[field])).slice(0, 3);
    return shuffle([w, ...others]);
  }

  function next() {
    if (i >= qs.length) return finish();
    const { w, kind } = qs[i];
    const prog = `<div class="progress"><i style="width:${(i / qs.length) * 100}%"></i></div><div class="qnum">${i + 1} / ${qs.length}</div>`;
    let body = "";
    if (kind === "order") {
      const sentence = w[2];
      const tokens = sentence.split(/\s+/);
      body = `<div class="q-label">단어를 순서대로 눌러 문장을 만드세요</div>
        <div class="q-hint">${esc(w[0])} = ${esc(w[1])}</div>
        <div class="answer-line" id="line"></div>
        <div class="chips" id="chips">${shuffle(tokens.map((t, k) => ({ t, k }))).map((o) => `<button class="chip" data-k="${o.k}">${esc(o.t)}</button>`).join("")}</div>
        <div class="btn-row"><button class="btn" id="reset">다시</button><button class="btn primary" id="check">확인</button></div>`;
    } else {
      const field = kind === "en2ko" ? 1 : 0;
      const opts = options(w, field);
      const q = kind === "en2ko" ? `<div class="q-big">${esc(w[0])}</div><div class="q-label">뜻은?</div>`
        : kind === "ko2en" ? `<div class="q-big ko">${esc(w[1])}</div><div class="q-label">영어로는?</div>`
        : `<button class="listen-big" data-say="${esc(w[0])}">🔊</button><div class="q-label">들리는 단어를 고르세요</div>`;
      body = `${q}<div class="opts">${opts.map((o) => `<button class="opt" data-ok="${o === w ? 1 : 0}">${esc(o[field])}</button>`).join("")}</div>`;
    }
    app.innerHTML = `${header("퀴즈", "#/quiz")}<main class="page">${prog}<div class="quiz">${body}</div><div id="fb"></div></main>`;

    if (kind === "listen") setTimeout(() => speak(w[0]), 300);
    if (kind === "order") setupOrder(w);
    else app.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
      const ok = b.dataset.ok === "1";
      app.querySelectorAll(".opt").forEach((x) => { x.disabled = true; if (x.dataset.ok === "1") x.classList.add("right"); });
      if (!ok) b.classList.add("wrong");
      answered(ok, w);
    }));
  }

  function setupOrder(w) {
    const tokens = w[2].split(/\s+/);
    const picked = [];
    const line = $("#line"), chips = $("#chips");
    const draw = () => { line.innerHTML = picked.map((k) => `<span class="chip on">${esc(tokens[k])}</span>`).join(" ") || `<span class="muted">여기에 문장이 만들어져요</span>`; };
    draw();
    chips.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { if (c.disabled) return; picked.push(+c.dataset.k); c.disabled = true; draw(); }));
    $("#reset").onclick = () => { picked.length = 0; chips.querySelectorAll(".chip").forEach((c) => (c.disabled = false)); draw(); };
    $("#check").onclick = () => {
      if (picked.length < tokens.length) { toast("단어를 모두 골라주세요"); return; }
      const ok = picked.map((k) => tokens[k]).join(" ") === tokens.join(" ");
      $("#check").disabled = $("#reset").disabled = true;
      line.classList.add(ok ? "right" : "wrong");
      answered(ok, w, w[2]);
    };
  }

  function answered(ok, w, sentence) {
    if (ok) score++; else wrongs.push(w);
    grade(w, ok);
    const fb = $("#fb");
    fb.innerHTML = `<div class="feedback ${ok ? "good" : "bad"}">
      <div>${ok ? "정답이에요! 🎉" : "아쉬워요 🥲"}</div>
      <div class="fb-word"><b>${esc(w[0])}</b> = ${esc(w[1])} ${speakBtn(sentence || w[0])}</div>
      ${sentence && !ok ? `<div class="muted">${esc(sentence)}</div>` : ""}
      <button class="btn primary wide" id="nextq">${i + 1 < qs.length ? "다음 문제" : "결과 보기"}</button>
    </div>`;
    if (sentence) speak(sentence);
    $("#nextq").onclick = () => { i++; next(); };
    fb.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function finish() {
    state.quizzes.push({ date: dayKey(), score, total: qs.length });
    logActivity("quiz");
    const msg = score === qs.length ? "만점! 대단해요 🏆" : score >= 7 ? "아주 잘했어요 👏" : score >= 4 ? "좋아요, 조금만 더! 💪" : "괜찮아요, 다시 해봐요 🌱";
    app.innerHTML = `${header("퀴즈 결과", "#/quiz")}
    <main class="page center">
      <div class="done-emoji">${score >= 7 ? "🏆" : "🌱"}</div>
      <h2>${score} / ${qs.length}</h2>
      <p>${msg}</p>
      ${wrongs.length ? `<div class="card left"><div class="label">틀린 단어</div>${wrongs.map((w) => `<div class="row"><span><b>${esc(w[0])}</b> · ${esc(w[1])}</span>${speakBtn(w[0])}</div>`).join("")}</div>` : ""}
      <div class="btn-row"><a class="btn" href="#/">홈으로</a><button class="btn primary" id="retry">다시 풀기</button></div>
    </main>`;
    $("#retry").onclick = () => runQuiz(scope);
  }
  next();
}

/* ---------- 화면: 선생님 대화 (목록) ---------- */
function viewTalk() {
  setNav("talk");
  const hasKey = !!state.settings.apiKey;
  app.innerHTML = `${header("선생님 대화")}
  <main class="page">
    <section class="teacher-hero card">
      <div class="avatar">👩‍🏫</div>
      <div><b>Emma 선생님</b><div class="muted">"Don't worry about mistakes. Let's talk!"</div></div>
    </section>

    <h3 class="section-title">📖 대본 롤플레이 <small>무료</small></h3>
    <div class="list">
      ${ROLEPLAYS.map((r) => `<a class="list-item" href="#/talk/role/${r.id}"><span class="emoji">${r.emoji}</span><span class="grow"><b>${r.title}</b><small>${r.desc}</small></span><span class="count">›</span></a>`).join("")}
    </div>

    <h3 class="section-title">✨ AI 선생님과 자유 대화</h3>
    ${hasKey ? `<div class="list">
      ${AI_TOPICS.map((t) => `<a class="list-item" href="#/talk/ai/${t.id}"><span class="emoji">${t.emoji}</span><span class="grow"><b>${t.title}</b></span><span class="count">›</span></a>`).join("")}
    </div>` : `<div class="card soft">
      <p>AI 선생님과 자유롭게 대화하려면 Claude API 키가 필요해요. 키는 이 휴대폰에만 저장돼요.</p>
      <a class="btn primary wide" href="#/settings">설정에서 키 입력하기</a>
    </div>`}
  </main>`;
}

/* ---------- 화면: 대본 롤플레이 ---------- */
function viewRoleplay(id) {
  setNav("talk");
  const rp = ROLEPLAYS.find((r) => r.id === id);
  if (!rp) { location.hash = "#/talk"; return; }
  app.innerHTML = `${header(`${rp.emoji} ${rp.title}`, "#/talk")}
  <main class="page chat-page"><div class="chat" id="chat"></div><div class="choices" id="choices"></div></main>`;
  const chat = $("#chat"), choices = $("#choices");
  let step = 0;

  function bubble(who, en, ko) {
    const div = document.createElement("div");
    div.className = `msg ${who}`;
    div.innerHTML = `${who === "teacher" ? `<span class="who">${rp.partner || "👩‍🏫"}</span>` : ""}
      <div class="bubble"><div>${esc(en)}</div>${ko ? `<div class="trans">${esc(ko)}</div>` : ""}
      <div class="bubble-tools">${speakBtn(en)}${ko ? `<button class="mini" data-trans>뜻</button>` : ""}</div></div>`;
    chat.appendChild(div);
    const t = div.querySelector("[data-trans]");
    if (t) t.onclick = () => div.classList.toggle("show-trans");
    div.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function show() {
    const s = rp.steps[step];
    bubble("teacher", s.teacher, s.ko);
    speak(s.teacher);
    const opts = s.options.length > 1 ? shuffle(s.options) : s.options;
    choices.innerHTML = `<div class="choice-label">어떻게 답할까요?</div>` + opts.map((o, i) =>
      `<div class="choice"><button class="opt choice-btn" data-i="${i}"><span>${esc(o[0])}</span><small>${esc(o[1])}</small></button>${speakBtn(o[0])}</div>`).join("") +
      `<button class="btn ghost wide" id="speakAns">🎤 직접 말해서 답하기</button>`;
    choices.querySelectorAll(".choice-btn").forEach((b) => (b.onclick = () => choose(opts[b.dataset.i], b)));
    $("#speakAns").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.textContent = "듣고 있어요… 🎙️";
      try {
        const alts = await listen();
        let best = null;
        for (const o of opts) { const r = scoreSpeech(o[0], alts); if (!best || r.score > best.r.score) best = { o, r }; }
        logActivity("speak");
        if (best.r.score >= 50) { toast(`인식: “${best.r.heard}” (${best.r.score}점)`); choose(best.o, null); }
        else { toast(`“${alts[0]}” 라고 들렸어요. 보기 문장을 말해보세요!`); btn.textContent = "🎤 직접 말해서 답하기"; }
      } catch (err) { toast(speechErrorText(err)); btn.textContent = "🎤 직접 말해서 답하기"; }
    };
  }

  function choose(o, btn) {
    if (!o[2]) {
      if (btn) btn.classList.add("wrong");
      toast(`💡 ${o[3] || "다른 답을 골라보세요"}`);
      return;
    }
    bubble("me", o[0]);
    choices.innerHTML = "";
    step++;
    if (step < rp.steps.length) setTimeout(show, 700);
    else {
      logActivity("talk");
      setTimeout(() => {
        choices.innerHTML = `<div class="finish card"><div class="done-emoji">🎉</div><b>대화 완료!</b><p class="muted">잘했어요. 다른 상황도 연습해볼까요?</p>
          <div class="btn-row"><a class="btn" href="#/talk">목록으로</a><button class="btn primary" id="again">다시 하기</button></div></div>`;
        $("#again").onclick = () => viewRoleplay(id);
      }, 600);
    }
  }
  show();
}

/* ---------- AI 선생님 (Claude API, 브라우저에서 직접 호출) ---------- */
const AI_MODEL = "claude-sonnet-5-5"; // AI 대화는 Claude Sonnet 5.5로 고정
const FALLBACK_MODELS = ["claude-sonnet-5-5"];
const TUTOR_SYSTEM = `You are Emma, a warm, patient native English teacher chatting with Jongsu, a Korean learner whose English is at an easy beginner to lower-intermediate level (about CEFR A1-A2, level 2-4 out of 10). Jongsu works as a physical therapist and is learning for travel, daily conversation and self-improvement.

Rules:
- Use easy, natural everyday English (A1-A2): short sentences, common words, simple tenses. Avoid idioms and long sentences. Usually 2-3 short sentences per turn.
- Always end with ONE easy question so the conversation keeps going.
- Be encouraging and friendly. Use an emoji now and then.
- If the learner's message has a grammar or word mistake, add a line starting with "💡" that shows the better sentence in English, followed by a very short explanation in Korean. Only correct the most important mistake, and also suggest a more natural expression when the sentence is correct but sounds unnatural. If there is no mistake, don't add this line.
- If the learner writes in Korean, gently help: show how to say it in English on a "💡" line, then continue in English.
- As the LAST line, always add "🇰🇷 " followed by a natural Korean translation of your English reply (not the 💡 line).
- Never use markdown headings, bullet lists or bold text.`;

const aiChats = {}; // 주제별 대화 기록 (화면을 떠나도 앱을 닫기 전까지 유지)

async function callClaude(messages, system) {
  const model = AI_MODEL;
  const body = {
    model,
    max_tokens: 2048,
    system,
    messages,
    output_config: { effort: "low" },
  };
  const headers = {
    "content-type": "application/json",
    "x-api-key": state.settings.apiKey.trim(),
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (FALLBACK_MODELS.includes(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || "";
    const e = new Error(
      res.status === 401 ? "API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요." :
      res.status === 403 ? "이 키로는 사용할 수 없어요. 키 권한을 확인해 주세요." :
      res.status === 429 ? "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." :
      res.status === 529 || res.status >= 500 ? "AI 서버가 바빠요. 잠시 후 다시 시도해 주세요." :
      /credit|balance/i.test(msg) ? "API 크레딧이 부족해요. Anthropic 콘솔에서 충전해 주세요." :
      `오류가 났어요 (${res.status}) ${msg}`);
    throw e;
  }
  if (data.stop_reason === "refusal") throw new Error("이 내용에는 답할 수 없대요. 다른 이야기를 해볼까요?");
  return data;
}

function splitReply(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const en = [], tips = [], ko = [];
  for (const l of lines) {
    if (l.startsWith("🇰🇷")) ko.push(l.replace(/^🇰🇷\s*/, ""));
    else if (l.startsWith("💡")) tips.push(l.replace(/^💡\s*/, ""));
    else en.push(l);
  }
  return { en: en.join(" "), tips, ko: ko.join(" ") };
}

function viewAiChat(topicId) {
  setNav("talk");
  const topic = AI_TOPICS.find((t) => t.id === topicId);
  if (!topic) { location.hash = "#/talk"; return; }
  if (!state.settings.apiKey) { location.hash = "#/settings"; return; }
  const system = `${TUTOR_SYSTEM}\n\nToday's activity: ${topic.prompt}${state.settings.name ? `\nHer name is ${state.settings.name}.` : ""}`;
  const convo = aiChats[topicId] || (aiChats[topicId] = { messages: [], view: [] });

  app.innerHTML = `${header(`${topic.emoji} ${topic.title}`, "#/talk")}
  <main class="page chat-page">
    <div class="chat" id="chat"></div>
    <form class="composer" id="composer">
      <button type="button" class="round-btn mic" id="mic" aria-label="말로 입력">🎤</button>
      <input id="input" autocomplete="off" placeholder="영어로 답해보세요 (한국어도 OK)" />
      <button class="round-btn send" aria-label="보내기">➤</button>
    </form>
    <div class="chat-tools"><button class="mini" id="restart">처음부터 다시</button></div>
  </main>`;
  const chat = $("#chat"), input = $("#input");

  function addBubble(item, animate = true) {
    const div = document.createElement("div");
    div.className = `msg ${item.who}`;
    if (item.who === "me") {
      div.innerHTML = `<div class="bubble">${esc(item.text)}</div>`;
    } else if (item.who === "error") {
      div.innerHTML = `<div class="bubble err">${esc(item.text)}</div>`;
    } else {
      const r = item.parsed;
      div.innerHTML = `<span class="who">👩‍🏫</span><div class="bubble">
        <div>${esc(r.en)}</div>
        ${r.tips.map((t) => `<div class="tip">💡 ${esc(t)}</div>`).join("")}
        ${r.ko ? `<div class="trans">${esc(r.ko)}</div>` : ""}
        <div class="bubble-tools">${speakBtn(r.en)}${r.ko ? `<button class="mini" data-trans>뜻</button>` : ""}</div></div>`;
      const t = div.querySelector("[data-trans]");
      if (t) t.onclick = () => div.classList.toggle("show-trans");
    }
    chat.appendChild(div);
    div.scrollIntoView({ behavior: animate ? "smooth" : "auto", block: "end" });
  }
  convo.view.forEach((v) => addBubble(v, false));

  let busy = false;
  async function ask() {
    busy = true;
    const typing = document.createElement("div");
    typing.className = "msg teacher";
    typing.innerHTML = `<span class="who">👩‍🏫</span><div class="bubble typing"><i></i><i></i><i></i></div>`;
    chat.appendChild(typing);
    typing.scrollIntoView({ behavior: "smooth", block: "end" });
    try {
      const data = await callClaude(convo.messages, system);
      // 응답 블록을 그대로 대화 기록에 남겨야 다음 요청에서 오류가 나지 않음
      convo.messages.push({ role: "assistant", content: data.content });
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const item = { who: "teacher", parsed: splitReply(text) };
      convo.view.push(item);
      typing.remove();
      addBubble(item);
      speak(item.parsed.en);
    } catch (err) {
      typing.remove();
      convo.messages.pop(); // 실패한 사용자 메시지는 기록에서 빼고 다시 보낼 수 있게
      const item = { who: "error", text: err.message || "연결에 실패했어요. 인터넷을 확인해 주세요." };
      addBubble(item);
      return false;
    } finally {
      busy = false;
    }
    return true;
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    const item = { who: "me", text };
    convo.view.push(item);
    addBubble(item);
    convo.messages.push({ role: "user", content: text });
    input.value = "";
    const ok = await ask();
    if (ok) logActivity("talk");
  }

  $("#composer").onsubmit = (e) => { e.preventDefault(); send(input.value); };
  $("#mic").onclick = async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains("listening")) return;
    b.classList.add("listening");
    try { const alts = await listen(); input.value = alts[0]; logActivity("speak"); input.focus(); }
    catch (err) { toast(speechErrorText(err)); }
    finally { b.classList.remove("listening"); }
  };
  $("#restart").onclick = () => { delete aiChats[topicId]; viewAiChat(topicId); };

  if (!convo.messages.length) {
    convo.messages.push({ role: "user", content: "(She just opened the chat. Please start the conversation.)" });
    ask().then((ok) => { if (!ok) convo.messages.length = 0; });
  }
}

/* ---------- 화면: 문법 ---------- */
function viewGrammar() {
  setNav("grammar");
  const done = GRAMMAR.filter(grammarDone).length;
  const item = (l) => {
    const g = state.grammar[l.id];
    const mark = grammarDone(l) ? `<span class="done-mark">✓</span>` : g ? `<span class="count">${g.best}/${g.total}</span>` : `<span class="count">›</span>`;
    return `<a class="list-item" href="#/grammar/${l.id}">
      <span class="lesson-no">${l.no}</span>
      <span class="grow"><b>${esc(l.title)}</b><small>${esc(l.summary)}</small></span>${mark}</a>`;
  };
  app.innerHTML = `${header("문법")}
  <main class="page">
    <section class="card grammar-progress">
      <div class="row"><b>문법 30강</b><span class="muted">${done} / ${GRAMMAR.length} 완료</span></div>
      <span class="bar"><i style="width:${Math.round((done / GRAMMAR.length) * 100)}%"></i></span>
      <p class="muted small">설명을 읽고, 예문을 듣고, 연습 문제를 풀어요. 70% 이상 맞히면 완료!</p>
    </section>
    <h3 class="section-title">🌱 기초 <small>1~15강</small></h3>
    <div class="list">${GRAMMAR.filter((l) => l.level === "기초").map(item).join("")}</div>
    <h3 class="section-title">💙 활용 <small>16~30강</small></h3>
    <div class="list">${GRAMMAR.filter((l) => l.level !== "기초").map(item).join("")}</div>
  </main>`;
}

function viewGrammarLesson(id) {
  setNav("grammar");
  const l = GRAMMAR.find((x) => x.id === id);
  if (!l) { location.hash = "#/grammar"; return; }
  const i = GRAMMAR.indexOf(l);
  const prev = GRAMMAR[i - 1], next = GRAMMAR[i + 1];
  const g = state.grammar[l.id];
  app.innerHTML = `${header(`${l.no}강`, "#/grammar")}
  <main class="page">
    <section class="lesson-head">
      <span class="pill">${esc(l.level)}</span>
      <h2>${esc(l.title)}</h2>
      <p>${esc(l.summary)}</p>
    </section>
    <div class="card">
      <div class="label">📌 핵심 정리</div>
      <ul class="points">${l.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
    </div>
    <h3 class="section-title">🔊 예문</h3>
    <div class="list">
      ${l.examples.map((e) => `<div class="card example"><div class="grow"><div class="en">${esc(e[0])}</div><div class="ko">${esc(e[1])}</div></div>${speakBtn(e[0])}</div>`).join("")}
    </div>
    <a class="btn primary wide big-btn" href="#/grammar/${l.id}/practice">✏️ 연습 문제 풀기 (${l.exercises.length}문제)</a>
    ${g ? `<p class="foot-note">최고 점수 ${g.best} / ${g.total}${grammarDone(l) ? " · 완료 ✓" : ""}</p>` : ""}
    <div class="btn-row">
      ${prev ? `<a class="btn" href="#/grammar/${prev.id}">‹ ${prev.no}강</a>` : ""}
      ${next ? `<a class="btn" href="#/grammar/${next.id}">${next.no}강 ›</a>` : ""}
    </div>
  </main>`;
}

function runGrammar(id) {
  setNav("grammar");
  const l = GRAMMAR.find((x) => x.id === id);
  if (!l) { location.hash = "#/grammar"; return; }
  const qs = l.exercises.map((e) => {
    const order = shuffle(e.options.map((_, k) => k));
    return { ...e, order };
  });
  let i = 0, score = 0;
  const back = `#/grammar/${l.id}`;

  function show() {
    if (i >= qs.length) return finish();
    const q = qs[i];
    const isSentence = !q.q.includes("___");
    const prompt = isSentence
      ? `<div class="q-label">${esc(q.q)}</div><div class="q-big ko small-q">${esc(q.ko)}</div>`
      : `<div class="q-sentence">${esc(q.q).replace("___", '<span class="blank">___</span>')}</div><div class="q-label">${esc(q.ko)}</div>`;
    app.innerHTML = `${header(`${l.no}강 연습`, back)}
    <main class="page">
      <div class="progress"><i style="width:${(i / qs.length) * 100}%"></i></div><div class="qnum">${i + 1} / ${qs.length}</div>
      <div class="quiz">${prompt}
        <div class="opts">${q.order.map((k) => `<button class="opt" data-k="${k}">${esc(q.options[k])}</button>`).join("")}</div>
      </div>
      <div id="fb"></div>
    </main>`;
    app.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
      const k = +b.dataset.k, ok = k === q.answer;
      app.querySelectorAll(".opt").forEach((x) => { x.disabled = true; if (+x.dataset.k === q.answer) x.classList.add("right"); });
      if (!ok) b.classList.add("wrong"); else score++;
      const full = isSentence ? q.options[q.answer] : q.q.replace("___", q.options[q.answer]);
      $("#fb").innerHTML = `<div class="feedback ${ok ? "good" : "bad"}">
        <div>${ok ? "정답이에요! 🎉" : "아쉬워요 🥲"}</div>
        <div class="fb-word">${esc(full)} ${speakBtn(full)}</div>
        <div class="why">💡 ${esc(q.why)}</div>
        <button class="btn primary wide" id="nextq">${i + 1 < qs.length ? "다음 문제" : "결과 보기"}</button>
      </div>`;
      speak(full);
      $("#nextq").onclick = () => { i++; show(); };
      $("#fb").scrollIntoView({ behavior: "smooth", block: "end" });
    }));
  }

  function finish() {
    const prev = state.grammar[l.id];
    state.grammar[l.id] = { best: Math.max(score, prev ? prev.best : 0), total: qs.length };
    logActivity("grammar");
    const passed = score >= Math.ceil(qs.length * 0.7);
    const next = GRAMMAR[GRAMMAR.indexOf(l) + 1];
    app.innerHTML = `${header(`${l.no}강 결과`, back)}
    <main class="page center">
      <div class="done-emoji">${passed ? "🌸" : "🌱"}</div>
      <h2>${score} / ${qs.length}</h2>
      <p>${score === qs.length ? "만점! 완벽해요 🏆" : passed ? "통과! 잘했어요 👏" : "조금만 더! 설명을 다시 보고 도전해요 💪"}</p>
      <div class="btn-row">
        <button class="btn" id="retry">다시 풀기</button>
        ${passed && next ? `<a class="btn primary" href="#/grammar/${next.id}">${next.no}강으로 ›</a>` : `<a class="btn primary" href="${back}">설명 다시 보기</a>`}
      </div>
      <p class="foot-note"><a href="#/grammar">문법 목록으로</a></p>
    </main>`;
    $("#retry").onclick = () => runGrammar(id);
  }
  show();
}

/* ---------- 화면: 학습 기록 ---------- */
function viewStats() {
  setNav("stats");
  const learned = ALL_WORDS.filter(isLearned).length;
  const phrases = Object.keys(state.phrasesDone).length;
  const qz = state.quizzes;
  const avg = qz.length ? Math.round((qz.reduce((a, q) => a + q.score / q.total, 0) / qz.length) * 100) : 0;
  const studyDays = Object.keys(state.days).filter((k) => activeOn(new Date(k + "T12:00"))).length;

  // 최근 4주 달력
  const today = new Date();
  const start = addDays(today, -27);
  const cells = [];
  for (let k = 0; k < 28; k++) {
    const d = addDays(start, k);
    const day = state.days[dayKey(d)];
    const n = day ? Object.values(day).reduce((a, b) => a + b, 0) : 0;
    const lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : 3;
    cells.push(`<div class="cell l${lvl} ${dayKey(d) === dayKey() ? "today" : ""}" title="${dayKey(d)}">${d.getDate()}</div>`);
  }

  // 최근 7일 막대
  const week = [];
  let maxN = 1;
  for (let k = 6; k >= 0; k--) {
    const d = addDays(today, -k);
    const day = state.days[dayKey(d)] || {};
    const n = Object.values(day).reduce((a, b) => a + b, 0);
    maxN = Math.max(maxN, n);
    week.push({ label: "일월화수목금토"[d.getDay()], n });
  }

  app.innerHTML = `${header("학습 기록")}
  <main class="page">
    <section class="streak-card">
      <div class="flame lit">🔥</div>
      <div><div class="big">${streak()}일 연속</div><div class="sub">최고 기록 ${bestStreak()}일 · 총 ${studyDays}일 공부</div></div>
    </section>
    <section class="stat-grid">
      <div class="stat"><b>${learned}</b><span>외운 단어</span></div>
      <div class="stat"><b>${GRAMMAR.filter(grammarDone).length}</b><span>끝낸 문법</span></div>
      <div class="stat"><b>${phrases}</b><span>익힌 표현</span></div>
      <div class="stat"><b>${qz.length}</b><span>푼 퀴즈</span></div>
      <div class="stat"><b>${avg}%</b><span>퀴즈 평균</span></div>
      <div class="stat"><b>${state.speech.tries ? Math.round((state.speech.good / state.speech.tries) * 100) : 0}%</b><span>발음 80점↑</span></div>
    </section>

    <h3 class="section-title">최근 7일 활동</h3>
    <div class="card">
      <div class="bars">${week.map((w) => `<div class="bar-col"><div class="bar-val">${w.n || ""}</div><div class="bar-fill" style="height:${Math.round((w.n / maxN) * 100)}%"></div><div class="bar-label">${w.label}</div></div>`).join("")}</div>
    </div>

    <h3 class="section-title">최근 4주</h3>
    <div class="card"><div class="cal">${cells.join("")}</div>
      <div class="legend"><span class="cell l0"></span>쉼 <span class="cell l1"></span>조금 <span class="cell l2"></span>보통 <span class="cell l3"></span>열심히</div>
    </div>

    <h3 class="section-title">주제별 단어</h3>
    <div class="list">
      ${WORD_DECKS.map((d) => {
        const l = d.words.filter(isLearned).length;
        return `<div class="list-item"><span class="emoji">${d.emoji}</span><span class="grow"><b>${d.title}</b><span class="bar"><i style="width:${Math.round((l / d.words.length) * 100)}%"></i></span></span><span class="count">${l}/${d.words.length}</span></div>`;
      }).join("")}
    </div>
  </main>`;
}

/* ---------- 화면: 설정 ---------- */
function viewSettings() {
  setNav("");
  const s = state.settings;
  app.innerHTML = `${header("설정", "#/")}
  <main class="page">
    <div class="card form">
      <label>내 이름 (선택)<input id="name" value="${esc(s.name)}" placeholder="예: 지수" /></label>
      <label>말하기 속도 <span id="rateV">${s.rate.toFixed(2)}배</span>
        <input id="rate" type="range" min="0.5" max="1.2" step="0.05" value="${s.rate}" /></label>
      <button class="btn" id="testVoice">🔊 목소리 들어보기</button>
    </div>

    <h3 class="section-title">✨ AI 선생님 (선택)</h3>
    <div class="card form">
      <p class="muted small">AI 자유 대화에는 Anthropic의 Claude API 키가 필요해요. console.anthropic.com 에서 발급받을 수 있고, 사용한 만큼 요금이 나와요. 키는 이 휴대폰 브라우저에만 저장되고 Anthropic 외에는 어디에도 보내지 않아요.</p>
      <label>API 키<input id="key" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-..." autocomplete="off" /></label>
      <p class="muted small">AI 모델: Claude Sonnet 5.5</p>
      <div class="btn-row"><button class="btn primary" id="saveKey">저장</button><button class="btn" id="testKey">연결 테스트</button></div>
      <div id="keyMsg" class="muted small"></div>
    </div>

    <h3 class="section-title">기록 관리</h3>
    <div class="card form">
      <p class="muted small">학습 기록은 이 휴대폰에만 저장돼요. 브라우저 데이터를 지우면 기록도 사라져요.</p>
      <button class="btn danger" id="reset">학습 기록 모두 지우기</button>
    </div>
    <p class="foot-note">종수영어정복 · 응원을 담아 만든 앱 💙</p>
  </main>`;

  $("#name").onchange = (e) => { s.name = e.target.value.trim(); save(); toast("저장했어요"); };
  $("#rate").oninput = (e) => { s.rate = +e.target.value; $("#rateV").textContent = s.rate.toFixed(2) + "배"; save(); };
  $("#testVoice").onclick = () => speak("Hello! Nice to meet you. Let's study English together.");
  $("#saveKey").onclick = () => { s.apiKey = $("#key").value.trim(); save(); toast(s.apiKey ? "저장했어요 ✨" : "키를 지웠어요"); };
  $("#testKey").onclick = async () => {
    s.apiKey = $("#key").value.trim(); save();
    const m = $("#keyMsg");
    if (!s.apiKey) { m.textContent = "키를 먼저 입력해 주세요."; return; }
    m.textContent = "연결 중…";
    try {
      await callClaude([{ role: "user", content: "Say hi in 3 words." }], "Reply very briefly.");
      m.textContent = "✅ 연결 성공! 선생님 대화에서 AI 대화를 시작할 수 있어요.";
    } catch (err) { m.textContent = "❌ " + err.message; }
  };
  $("#reset").onclick = () => {
    if (!confirm("정말 모든 학습 기록을 지울까요? 되돌릴 수 없어요.")) return;
    state = { ...structuredClone(DEFAULT_STATE), settings: state.settings };
    save();
    toast("기록을 지웠어요");
    location.hash = "#/";
  };
}

/* ---------- 라우터 ---------- */
function route() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/");
  const [a, b, c] = parts;
  window.scrollTo(0, 0);
  if (!a) return viewHome();
  if (a === "words") return b ? viewCards(b) : viewWords();
  if (a === "review") return viewCards(null, true);
  if (a === "phrases") return b ? viewPhraseSet(b) : viewPhrases();
  if (a === "quiz") return viewQuizHome();
  if (a === "talk") return b === "role" ? viewRoleplay(c) : b === "ai" ? viewAiChat(c) : viewTalk();
  if (a === "grammar") return c === "practice" ? runGrammar(b) : b ? viewGrammarLesson(b) : viewGrammar();
  if (a === "stats") return viewStats();
  if (a === "settings") return viewSettings();
  viewHome();
}
window.addEventListener("hashchange", route);
route();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
