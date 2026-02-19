/* /script.js
   Fixes:
   - Game startup: removed stray duplicate code block that referenced undefined variables.
   - PDF: centered margins, 10 questions per page, and no question blocks split across pages
     (render one HTML page per PDF page, instead of slicing one tall canvas).
   - Start modal: pick number of questions as 1..30.
*/
(() => {
  "use strict";

  // -------------------- Config --------------------
  const AUDIO_DIR = "audio";
  const FADE_OUT_SEC = 0.12;
  const LIMITER_THRESHOLD_DB = -6;

  // Top keyboard range (2 octaves): C4..B5 inclusive
  const KBD_START_OCT = 4;
  const KBD_OCTAVES = 2;

  // Mini keyboards (3 octaves): C3..B5 inclusive (second C is C4)
  const MINI_KBD_START_OCT = 3;
  const MINI_KBD_OCTAVES = 3;

  // PDF margins (pt)
  const PDF_MARGIN_PT = 28;

  const PC_TO_STEM = {
    0: "c",
    1: "csharp",
    2: "d",
    3: "dsharp",
    4: "e",
    5: "f",
    6: "fsharp",
    7: "g",
    8: "gsharp",
    9: "a",
    10: "asharp",
    11: "b",
  };

  const PC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const PC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const ACC_PCS = new Set([1, 3, 6, 8, 10]);

  const NOTE_OPTIONS = [
    { pc: 0, label: "C" },
    { pc: 1, label: "C#/Db" },
    { pc: 2, label: "D" },
    { pc: 3, label: "D#/Eb" },
    { pc: 4, label: "E" },
    { pc: 5, label: "F" },
    { pc: 6, label: "F#/Gb" },
    { pc: 7, label: "G" },
    { pc: 8, label: "G#/Ab" },
    { pc: 9, label: "A" },
    { pc: 10, label: "A#/Bb" },
    { pc: 11, label: "B" },
  ];

  // -------------------- DOM --------------------
  const $ = (id) => document.getElementById(id);

  const beginModal = $("beginModal");
  const beginBtn = $("beginBtn");
  const questionCountSelect = $("questionCountSelect");
  const pageAdvice = $("pageAdvice");

  const infoBtn = $("infoBtn");
  const infoModal = $("infoModal");
  const infoOk = $("infoOk");

  const downloadTaskBtn = $("downloadTaskBtn");
  const downloadScorecardBtn = $("downloadScorecardBtn");
  const resetBtn = $("resetBtn");
  const resetBtn2 = $("resetBtn2");

  const topKeyboardMount = $("topKeyboardMount");

  const quizTitle = $("quizTitle");
  const quizMeta = $("quizMeta");
  const questionsList = $("questionsList");
  const submitBtn = $("submitBtn");

  const resultsPanel = $("resultsPanel");
  const resultsSummary = $("resultsSummary");

  const taskSheetTemplate = $("taskSheetTemplate");
  const scorecardTemplate = $("scorecardTemplate");

  // -------------------- Audio (WebAudio) --------------------
  let audioCtx = null;
  let masterGain = null;
  let limiter = null;

  const bufferPromiseCache = new Map();
  const activeVoices = new Set();

  function ensureAudioGraph() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      alert("Your browser doesn’t support Web Audio (required for playback).");
      return null;
    }

    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;

    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;

    masterGain.connect(limiter);
    limiter.connect(audioCtx.destination);
    return audioCtx;
  }

  async function resumeAudioIfNeeded() {
    const ctx = ensureAudioGraph();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {}
    }
  }

  function stopAllNotes(fadeSec = 0.06) {
    const ctx = ensureAudioGraph();
    if (!ctx) return;

    const now = ctx.currentTime;
    const fade = Math.max(0.02, Number.isFinite(fadeSec) ? fadeSec : 0.06);

    for (const v of Array.from(activeVoices)) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, fade / 6);
        const stopAt = Math.max(now + fade, (v.startTime || now) + 0.001);
        v.src.stop(stopAt + 0.02);
      } catch {}
    }
  }

  function trackVoice(src, gain, startTime) {
    const voice = { src, gain, startTime };
    activeVoices.add(voice);
    src.onended = () => activeVoices.delete(voice);
    return voice;
  }

  function noteUrl(stem, octaveNum) {
    return `${AUDIO_DIR}/${stem}${octaveNum}.mp3`;
  }

  function loadBuffer(url) {
    if (bufferPromiseCache.has(url)) return bufferPromiseCache.get(url);

    const p = (async () => {
      const ctx = ensureAudioGraph();
      if (!ctx) return null;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    })();

    bufferPromiseCache.set(url, p);
    return p;
  }

  function playBufferWindowed(buffer, whenSec, playSec, fadeOutSec, gain = 1) {
    const ctx = ensureAudioGraph();
    if (!ctx || !masterGain) return null;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    const safeGain = Math.max(0, Number.isFinite(gain) ? gain : 1);

    const fadeIn = 0.01;
    const endAt = whenSec + Math.max(0.05, playSec);

    g.gain.setValueAtTime(0, whenSec);
    g.gain.linearRampToValueAtTime(safeGain, whenSec + fadeIn);

    const fadeStart = Math.max(whenSec + 0.02, endAt - Math.max(0.06, fadeOutSec));
    g.gain.setValueAtTime(safeGain, fadeStart);
    g.gain.linearRampToValueAtTime(0, endAt);

    src.connect(g);
    g.connect(masterGain);

    trackVoice(src, g, whenSec);
    src.start(whenSec);
    src.stop(endAt + 0.03);
    return src;
  }

  function pcFromPitch(p) {
    return ((p % 12) + 12) % 12;
  }
  function octFromPitch(p) {
    return Math.floor(p / 12);
  }
  function pitchFromPcOct(pc, oct) {
    return oct * 12 + pc;
  }
  function getStemForPc(pc) {
    return PC_TO_STEM[(pc + 12) % 12] || null;
  }

  async function loadPitchBuffer(pitch) {
    const pc = pcFromPitch(pitch);
    const oct = octFromPitch(pitch);
    const stem = getStemForPc(pc);
    if (!stem) return { missingUrl: null, buffer: null };

    const url = noteUrl(stem, oct);
    const buf = await loadBuffer(url);
    if (!buf) return { missingUrl: url, buffer: null };
    return { missingUrl: null, buffer: buf };
  }

  async function playPitchesWindowed(pitches, playSec = 1.4) {
    await resumeAudioIfNeeded();
    const ctx = ensureAudioGraph();
    if (!ctx) return false;

    const whenSec = ctx.currentTime + 0.03;
    const results = await Promise.all(pitches.map(loadPitchBuffer));
    const missing = results.find((r) => r?.missingUrl);
    if (missing?.missingUrl) {
      alert(`Missing audio sample: ${missing.missingUrl}`);
      return false;
    }

    const bufs = results.map((r) => r?.buffer).filter(Boolean);
    if (!bufs.length) return false;

    const perNoteGain = 0.8 / Math.max(1, bufs.length);
    for (const b of bufs) playBufferWindowed(b, whenSec, playSec, FADE_OUT_SEC, perNoteGain);
    return true;
  }

  // -------------------- Theory helpers --------------------
  function noteLabelForPc(pc) {
    const p = ((pc % 12) + 12) % 12;
    return ACC_PCS.has(p) ? `${PC_SHARP[p]}/${PC_FLAT[p]}` : PC_SHARP[p];
  }

  function chordName(rootPc, quality) {
    const r = noteLabelForPc(rootPc);
    const q = quality === "major" ? "Major" : "Minor";
    return `${r} ${q}`;
  }

  function triadPcs(rootPc, quality) {
    const third = (rootPc + (quality === "major" ? 4 : 3)) % 12;
    const fifth = (rootPc + 7) % 12;
    return [rootPc, third, fifth];
  }

  function pcsToPretty(pcs) {
    return pcs.map(noteLabelForPc).join(", ");
  }

  // -------------------- Keyboard SVG (no labels) --------------------
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs = {}, children = []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      n.setAttribute(k, String(v));
    }
    for (const c of children) n.appendChild(c);
    return n;
  }

  function whiteIndexInOctave(pc) {
    const m = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    return m[pc] ?? null;
  }

  function buildKeyboardSvg({
    startPitch,
    octaves,
    widthPx = 980,
    heightPx = 190,
    interactive = true,
    ariaLabel = "Keyboard",
    highlight = null,
    onKeyDown = null,
  }) {
    const totalSemis = octaves * 12;
    const lo = startPitch;
    const hi = startPitch + totalSemis + 11;

    const all = [];
    for (let p = lo; p <= hi; p++) all.push(p);

    const WHITE_W = 28;
    const WHITE_H = 124;
    const BLACK_W = 17;
    const BLACK_H = 78;
    const BORDER = 10;
    const RADIUS = 18;

    const whitePitches = all.filter((p) => whiteIndexInOctave(pcFromPitch(p)) != null);
    const totalWhite = whitePitches.length;

    const innerW = totalWhite * WHITE_W;
    const outerW = innerW + BORDER * 2;
    const outerH = WHITE_H + BORDER * 2;

    const svg = svgEl("svg", {
      width: widthPx,
      height: heightPx,
      viewBox: `0 0 ${outerW} ${outerH}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": ariaLabel,
    });

    const style = svgEl("style");
    style.textContent = `
      .frame{ fill:#fff; stroke:#000; stroke-width:${BORDER}; rx:${RADIUS}; ry:${RADIUS}; }
      .w rect{ fill:#fff; stroke:#222; stroke-width:1; }
      .b rect{ fill:#111; stroke:#000; stroke-width:1; rx:3; ry:3; }
      .key { cursor: ${interactive ? "pointer" : "default"}; }
      .hit rect { fill: var(--kbdHit) !important; }
      .hitOk rect { fill: var(--kbdHitOk) !important; }
      .hitBad rect { fill: var(--kbdHitBad) !important; }
    `;
    svg.appendChild(style);

    svg.appendChild(
      svgEl("rect", {
        x: BORDER / 2,
        y: BORDER / 2,
        width: outerW - BORDER,
        height: outerH - BORDER,
        rx: RADIUS,
        ry: RADIUS,
        class: "frame",
      })
    );

    const gW = svgEl("g");
    const gB = svgEl("g");
    svg.appendChild(gW);
    svg.appendChild(gB);

    const startX = BORDER;
    const startY = BORDER;

    const whiteIndexByPitch = new Map();
    whitePitches.forEach((p, i) => whiteIndexByPitch.set(p, i));

    function classForPitch(p, base) {
      if (!highlight) return base;
      const c = highlight.get(p);
      if (!c) return base;
      if (c === "ok") return `${base} hitOk`;
      if (c === "bad") return `${base} hitBad`;
      return `${base} hit`;
    }

    // White keys
    for (let i = 0; i < whitePitches.length; i++) {
      const p = whitePitches[i];
      const x = startX + i * WHITE_W;

      const grp = svgEl("g", {
        class: `${classForPitch(p, "w")} key`,
        "data-pitch": String(p),
        tabindex: interactive ? "0" : "-1",
      });

      grp.appendChild(svgEl("rect", { x, y: startY, width: WHITE_W, height: WHITE_H }));
      if (interactive && typeof onKeyDown === "function") {
        grp.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          onKeyDown(p, grp);
        });
      }
      gW.appendChild(grp);
    }

    // Black keys
    const leftPcByBlack = { 1: 0, 3: 2, 6: 5, 8: 7, 10: 9 };
    for (let p = lo; p <= hi; p++) {
      const pc = pcFromPitch(p);
      if (!ACC_PCS.has(pc)) continue;

      const leftPc = leftPcByBlack[pc];
      if (leftPc == null) continue;

      const oct = octFromPitch(p);
      const leftWhitePitch = pitchFromPcOct(leftPc, oct);

      const wi = whiteIndexByPitch.get(leftWhitePitch);
      if (wi == null) continue;

      const leftX = startX + wi * WHITE_W;
      const x = leftX + WHITE_W - BLACK_W / 2;

      const grp = svgEl("g", {
        class: `${classForPitch(p, "b")} key`,
        "data-pitch": String(p),
        tabindex: interactive ? "0" : "-1",
      });
      grp.appendChild(svgEl("rect", { x, y: startY, width: BLACK_W, height: BLACK_H }));

      if (interactive && typeof onKeyDown === "function") {
        grp.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          onKeyDown(p, grp);
        });
      }
      gB.appendChild(grp);
    }

    return svg;
  }

  function flashKeyGroup(groupEl, ms = 240) {
    if (!groupEl) return;
    groupEl.classList.add("hit");
    window.setTimeout(() => groupEl.classList.remove("hit"), ms);
  }

  // -------------------- Root-position pitch helpers (mini keyboards) --------------------
  function nextPitchAtOrAbove(pc, minPitch) {
    const want = ((pc % 12) + 12) % 12;
    let p = Math.max(0, Math.floor(minPitch));
    while (pcFromPitch(p) !== want) p += 1;
    return p;
  }

  function triadRootPositionPitches(rootPc, quality, rootOct = 4) {
    const rootPitch = pitchFromPcOct(rootPc, rootOct);
    const thirdPitch = rootPitch + (quality === "major" ? 4 : 3);
    const fifthPitch = rootPitch + 7;
    return [rootPitch, thirdPitch, fifthPitch];
  }

  function answeredRootPositionPitches(userPcs, rootOct = 4) {
    const [p0, p1, p2] = userPcs;
    if (p0 == null && p1 == null && p2 == null) return [];

    const rootPitch = p0 == null ? null : pitchFromPcOct(p0, rootOct);
    const start = rootPitch == null ? pitchFromPcOct(0, rootOct) : rootPitch;

    const first = rootPitch == null ? nextPitchAtOrAbove(p0 ?? 0, start) : rootPitch;
    const third = p1 == null ? null : nextPitchAtOrAbove(p1, first + 1);
    const fifth = p2 == null ? null : nextPitchAtOrAbove(p2, (third ?? first) + 1);

    return [first, third, fifth].filter((v) => v != null);
  }

  // -------------------- Game state --------------------
  const state = {
    started: false,
    submitted: false,
    questions: [],
    questionCount: 18,
  };

  function clampQuestions(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 18;
    return Math.min(30, Math.max(1, Math.round(v)));
  }

  function generateQuestions(count) {
    const target = clampQuestions(count);

    const pool = [];
    for (let rootPc = 0; rootPc < 12; rootPc++) {
      pool.push({ rootPc, quality: "major" });
      pool.push({ rootPc, quality: "minor" });
    }

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const picked = pool.slice(0, Math.min(target, pool.length));
    while (picked.length < target) {
      picked.push(pool[Math.floor(Math.random() * pool.length)]);
    }

    return picked.map((q, idx) => ({
      id: `q${idx + 1}`,
      rootPc: q.rootPc,
      quality: q.quality,
      correctPcs: triadPcs(q.rootPc, q.quality),
      userPcs: [null, null, null],
      marks: 0,
    }));
  }

  function resetGameToInitial() {
    stopAllNotes(0.08);

    state.started = false;
    state.submitted = false;
    state.questions = [];

    questionsList.innerHTML = "";
    resultsPanel.classList.add("hidden");
    resultsSummary.textContent = "—";

    submitBtn.disabled = true;
    downloadTaskBtn.disabled = true;
    downloadScorecardBtn.disabled = true;
    resetBtn.disabled = true;

    quizMeta.textContent = "—";
    if (quizTitle) quizTitle.textContent = "—";
    beginModal.classList.remove("hidden");

    updatePageAdvice();
  }

  function startGame() {
    state.started = true;
    state.submitted = false;
    state.questions = generateQuestions(state.questionCount);

    renderQuiz();
    submitBtn.disabled = false;
    downloadTaskBtn.disabled = false;
    downloadScorecardBtn.disabled = true;
    resetBtn.disabled = false;

    beginModal.classList.add("hidden");
  }

  // -------------------- Begin modal question-count logic --------------------
  function chunkArray(arr, size) {
    const out = [];
    const n = Math.max(1, Math.floor(size));
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function updatePageAdvice() {
    const qCount = clampQuestions(Number(questionCountSelect?.value ?? 18));
    state.questionCount = qCount;

    const pages = Math.ceil(qCount / 10);
    const perPage = qCount <= 10 ? `${qCount} on 1 page` : `10 per page (last page ${qCount % 10 || 10})`;

    if (pageAdvice) {
      pageAdvice.textContent = `PDF tip: ${qCount} questions → ${pages} A4 page(s), ${perPage}.`;
    }
  }

  // -------------------- Rendering --------------------
  function buildNoteSelect(selectId) {
    const sel = document.createElement("select");
    sel.id = selectId;

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— select —";
    sel.appendChild(opt0);

    for (const opt of NOTE_OPTIONS) {
      const o = document.createElement("option");
      o.value = String(opt.pc);
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    return sel;
  }

  function renderQuiz() {
    questionsList.innerHTML = "";

    const stamp = new Date();
    quizMeta.textContent = `Loaded: ${stamp.toLocaleString()}`;
    if (quizTitle) quizTitle.textContent = `${state.questions.length} Questions`;

    state.questions.forEach((q, index) => {
      const li = document.createElement("li");
      li.className = "qCard";
      li.dataset.qid = q.id;

      const top = document.createElement("div");
      top.className = "qTop";

      const title = document.createElement("div");
      title.className = "qTitle";
      title.textContent = `${index + 1}. ${chordName(q.rootPc, q.quality)}`;

      const marks = document.createElement("div");
      marks.className = "qMarks";
      marks.id = `${q.id}-marks`;
      marks.textContent = "0 / 3";

      top.appendChild(title);
      top.appendChild(marks);

      const grid = document.createElement("div");
      grid.className = "qGrid";

      const fields = [
        { label: "1st (root)", idx: 0 },
        { label: "3rd", idx: 1 },
        { label: "5th", idx: 2 },
      ];

      for (const f of fields) {
        const wrap = document.createElement("div");
        wrap.className = "qField";

        const lab = document.createElement("label");
        lab.setAttribute("for", `${q.id}-sel-${f.idx}`);
        lab.textContent = f.label;

        const sel = buildNoteSelect(`${q.id}-sel-${f.idx}`);
        sel.addEventListener("change", () => {
          q.userPcs[f.idx] = sel.value === "" ? null : Number(sel.value);
        });

        wrap.appendChild(lab);
        wrap.appendChild(sel);
        grid.appendChild(wrap);
      }

      const feedback = document.createElement("div");
      feedback.className = "qFeedback hidden";
      feedback.id = `${q.id}-feedback`;

      li.appendChild(top);
      li.appendChild(grid);
      li.appendChild(feedback);
      questionsList.appendChild(li);
    });
  }

  function setSelectDisabledAll(disabled) {
    const sels = questionsList.querySelectorAll("select");
    sels.forEach((s) => {
      s.disabled = disabled;
    });
  }

  // -------------------- Mini keyboards per question --------------------
  function makeMiniKeyboardBlock({ title, mountId, btnText, onPlay }) {
    const block = document.createElement("div");
    block.className = "miniKbdBlock";

    const t = document.createElement("div");
    t.className = "miniKbdTitle";
    t.textContent = title;

    const mount = document.createElement("div");
    mount.className = "mount miniMount";
    mount.id = mountId;

    const btnRow = document.createElement("div");
    btnRow.className = "miniBtnRow";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = btnText;
    btn.addEventListener("click", onPlay);
    btnRow.appendChild(btn);

    block.appendChild(t);
    block.appendChild(mount);
    block.appendChild(btnRow);
    return block;
  }

  function renderMiniKeyboardsForQuestion(q) {
    const fb = $(`${q.id}-feedback`);
    if (!fb) return;

    fb.innerHTML = "";
    fb.classList.remove("hidden");

    const row = document.createElement("div");
    row.className = "qFeedbackRow";

    const miniStartPitch = pitchFromPcOct(0, MINI_KBD_START_OCT);

    const correctPitches = triadRootPositionPitches(q.rootPc, q.quality, 4);
    const answeredPitches = answeredRootPositionPitches(q.userPcs, 4);

    const correctPcs = q.correctPcs.slice();
    const answeredPcs = q.userPcs.slice();

    const answeredMap = new Map();
    for (let i = 0; i < answeredPcs.length; i++) {
      const pc = answeredPcs[i];
      if (pc == null) continue;
      const pitch = answeredPitches[i] ?? null;
      if (pitch == null) continue;
      answeredMap.set(pitch, correctPcs.includes(pc) ? "ok" : "bad");
    }

    const correctMap = new Map();
    for (const p of correctPitches) correctMap.set(p, "ok");

    const answeredMountId = `${q.id}-mini-answered`;
    const correctMountId = `${q.id}-mini-correct`;

    const answeredBlock = makeMiniKeyboardBlock({
      title: "Your answered notes",
      mountId: answeredMountId,
      btnText: "Play Answered Notes",
      onPlay: async () => {
        await playPitchesWindowed(answeredPitches.length ? answeredPitches : correctPitches, 1.6);
      },
    });

    const correctBlock = makeMiniKeyboardBlock({
      title: "Correct notes",
      mountId: correctMountId,
      btnText: "Play Correct Notes",
      onPlay: async () => {
        await playPitchesWindowed(correctPitches, 1.6);
      },
    });

    row.appendChild(answeredBlock);
    row.appendChild(correctBlock);
    fb.appendChild(row);

    const line = document.createElement("div");
    line.className = "qAnswerLine";

    const chosenText = answeredPcs.map((pc) => (pc == null ? "—" : noteLabelForPc(pc))).join(", ");
    const correctText = pcsToPretty(correctPcs);

    const okClass = q.marks === 3 ? "ok" : q.marks === 0 ? "bad" : "";
    line.innerHTML = `
      <span class="${okClass}">
        Marks: <strong>${q.marks} / 3</strong>
      </span>
      <br>
      You chose: <strong>${chosenText}</strong>
      <br>
      Correct: <strong>${correctText}</strong>
    `;
    fb.appendChild(line);

    const answeredMount = $(answeredMountId);
    const correctMount = $(correctMountId);

    if (answeredMount) {
      answeredMount.innerHTML = "";
      answeredMount.appendChild(
        buildKeyboardSvg({
          startPitch: miniStartPitch,
          octaves: MINI_KBD_OCTAVES,
          widthPx: 520,
          heightPx: 120,
          interactive: false,
          ariaLabel: "Answered notes keyboard",
          highlight: answeredMap,
        })
      );
    }

    if (correctMount) {
      correctMount.innerHTML = "";
      correctMount.appendChild(
        buildKeyboardSvg({
          startPitch: miniStartPitch,
          octaves: MINI_KBD_OCTAVES,
          widthPx: 520,
          heightPx: 120,
          interactive: false,
          ariaLabel: "Correct notes keyboard",
          highlight: correctMap,
        })
      );
    }
  }

  // -------------------- Marking --------------------
  function markAll() {
    state.submitted = true;

    setSelectDisabledAll(true);
    submitBtn.disabled = true;

    let total = 0;
    const max = state.questions.length * 3;

    for (const q of state.questions) {
      const correct = q.correctPcs;
      const user = q.userPcs;

      let marks = 0;
      for (let i = 0; i < 3; i++) {
        if (user[i] != null && user[i] === correct[i]) marks += 1;
      }
      q.marks = marks;
      total += marks;

      const marksEl = $(`${q.id}-marks`);
      if (marksEl) marksEl.textContent = `${marks} / 3`;

      renderMiniKeyboardsForQuestion(q);
    }

    resultsSummary.innerHTML = `
      Total: <strong>${total} / ${max}</strong>
      <br>
      Percentage: <strong>${Math.round((total / max) * 1000) / 10}%</strong>
    `;
    resultsPanel.classList.remove("hidden");

    downloadScorecardBtn.disabled = false;
  }

  function validateBeforeSubmit() {
    return true;
  }

  // -------------------- PDF helpers --------------------
  function addCanvasToPdfPageCentered({ canvas, pdf, marginPt }) {
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    const usableW = pageW - marginPt * 2;
    const usableH = pageH - marginPt * 2;

    const scale = Math.min(usableW / canvas.width, usableH / canvas.height);
    const drawW = canvas.width * scale;
    const drawH = canvas.height * scale;

    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;

    const imgData = canvas.toDataURL("image/png");
    pdf.addImage(imgData, "PNG", x, y, drawW, drawH);
  }

  async function renderHtmlPagesToPdf({ hostEl, pages, filename }) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

    hostEl.innerHTML = "";
    hostEl.classList.remove("hidden");

    for (let i = 0; i < pages.length; i++) {
      hostEl.innerHTML = "";
      hostEl.appendChild(pages[i]);

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const canvas = await window.html2canvas(hostEl, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });

      if (i > 0) pdf.addPage("a4", "portrait");
      addCanvasToPdfPageCentered({ canvas, pdf, marginPt: PDF_MARGIN_PT });
    }

    pdf.save(filename);

    hostEl.classList.add("hidden");
    hostEl.innerHTML = "";
  }

  // -------------------- Task sheet PDF (10 questions per page) --------------------
  function buildTaskSheetPages() {
    const loadedAt = quizMeta.textContent || "";
    const totalQ = state.questions.length;
    const chunks = chunkArray(state.questions, 10);

    return chunks.map((chunk, pageIndex) => {
      const page = document.createElement("div");
      page.className = "printPage";

      const title = document.createElement("div");
      title.className = "sheetTitle";
      title.textContent = "Root Position Triads — Task Sheet";

      const meta = document.createElement("div");
      meta.className = "sheetMeta";
      meta.textContent = `${loadedAt} • ${totalQ} questions • Page ${pageIndex + 1} / ${chunks.length}`;

      const list = document.createElement("ol");
      list.className = "sheetList";

      chunk.forEach((q, localIdx) => {
        const number = pageIndex * 10 + localIdx + 1;

        const item = document.createElement("li");
        item.className = "sheetQ";

        const qname = document.createElement("div");
        qname.className = "sheetQName";
        qname.textContent = `${number}. ${chordName(q.rootPc, q.quality)}`;

        const row = document.createElement("div");
        row.className = "sheetLineRow";

        const labels = ["1st (root)", "3rd", "5th"];
        for (const lab of labels) {
          const box = document.createElement("div");
          box.className = "sheetLine";
          box.innerHTML = `<span>${lab}:</span> <span class="dots">............................</span>`;
          row.appendChild(box);
        }

        item.appendChild(qname);
        item.appendChild(row);
        list.appendChild(item);
      });

      page.appendChild(title);
      page.appendChild(meta);
      page.appendChild(list);
      return page;
    });
  }

  async function downloadTaskSheetPdf() {
    if (!state.started || !state.questions.length) return;

    const pages = buildTaskSheetPages();
    const fileStamp = new Date().toISOString().slice(0, 10);
    await renderHtmlPagesToPdf({
      hostEl: taskSheetTemplate,
      pages,
      filename: `Triads Task Sheet (${fileStamp}).pdf`,
    });
  }

  // -------------------- Scorecard PDF (10 questions per page) --------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  }

  function buildScorecardPages(playerName, total, max) {
    const loadedAt = quizMeta.textContent || "";
    const totalQ = state.questions.length;
    const chunks = chunkArray(state.questions, 10);

    return chunks.map((chunk, pageIndex) => {
      const page = document.createElement("div");
      page.className = "printPage";

      const title = document.createElement("div");
      title.className = "sheetTitle";
      title.textContent = "Root Position Triads — Scorecard";

      const meta = document.createElement("div");
      meta.className = "sheetMeta";
      meta.textContent = `${loadedAt} • ${totalQ} questions • Page ${pageIndex + 1} / ${chunks.length}`;

      page.appendChild(title);
      page.appendChild(meta);

      if (pageIndex === 0) {
        const top = document.createElement("div");
        top.className = "sheetQ";
        top.innerHTML = `
          <div class="sheetQName">Name: ${escapeHtml(playerName)}</div>
          <div style="font-weight:900;">
            Score: ${total} / ${max} (${Math.round((total / max) * 1000) / 10}%)
          </div>
        `;
        page.appendChild(top);
      }

      const list = document.createElement("ol");
      list.className = "sheetList";

      const startIdx = pageIndex * 10;
      chunk.forEach((q, localIdx) => {
        const idx = startIdx + localIdx;
        const item = document.createElement("li");
        item.className = "sheetQ";

        const chosen = q.userPcs.map((pc) => (pc == null ? "—" : noteLabelForPc(pc))).join(", ");
        const correct = pcsToPretty(q.correctPcs);

        item.innerHTML = `
          <div class="sheetQName">${idx + 1}. ${chordName(q.rootPc, q.quality)} — ${q.marks} / 3</div>
          <div style="font-weight:800; font-size:12px; opacity:.9; line-height:1.45;">
            Your answer: <strong>${escapeHtml(chosen)}</strong><br>
            Correct: <strong>${escapeHtml(correct)}</strong>
          </div>
        `;
        list.appendChild(item);
      });

      page.appendChild(list);
      return page;
    });
  }

  async function downloadScorecardPdf() {
    if (!state.submitted) {
      alert("Submit your answers first, then download the scorecard.");
      return;
    }

    const prev = localStorage.getItem("triads_player_name") || "";
    const name = (window.prompt("Enter your name for the scorecard:", prev) ?? "").trim();
    const playerName = name || "Player";
    if (name) localStorage.setItem("triads_player_name", name);

    const total = state.questions.reduce((a, q) => a + (q.marks || 0), 0);
    const max = state.questions.length * 3;

    const pages = buildScorecardPages(playerName, total, max);
    const fileStamp = new Date().toISOString().slice(0, 10);
    await renderHtmlPagesToPdf({
      hostEl: scorecardTemplate,
      pages,
      filename: `Triads Scorecard (${playerName}) (${fileStamp}).pdf`,
    });
  }

  // -------------------- Top keyboard init --------------------
  function initTopKeyboard() {
    topKeyboardMount.innerHTML = "";

    const startPitch = pitchFromPcOct(0, KBD_START_OCT);
    const svg = buildKeyboardSvg({
      startPitch,
      octaves: KBD_OCTAVES,
      widthPx: 1100,
      heightPx: 210,
      interactive: true,
      ariaLabel: "Interactive two-octave keyboard",
      onKeyDown: async (pitch, groupEl) => {
        await resumeAudioIfNeeded();
        stopAllNotes(0.02);

        await playPitchesWindowed([pitch], 0.9);
        flashKeyGroup(groupEl, 260);
      },
    });

    topKeyboardMount.appendChild(svg);
  }

  // -------------------- Events --------------------
  function bindEvents() {
    questionCountSelect?.addEventListener("change", updatePageAdvice);

    beginBtn.addEventListener("click", async () => {
      await resumeAudioIfNeeded();
      startGame();
    });

    infoBtn.addEventListener("click", () => infoModal.classList.remove("hidden"));
    infoOk.addEventListener("click", () => infoModal.classList.add("hidden"));
    infoModal.addEventListener("click", (e) => {
      if (e.target === infoModal) infoModal.classList.add("hidden");
    });

    downloadTaskBtn.addEventListener("click", downloadTaskSheetPdf);
    downloadScorecardBtn.addEventListener("click", downloadScorecardPdf);

    submitBtn.addEventListener("click", () => {
      if (!state.started || state.submitted) return;
      if (!validateBeforeSubmit()) return;
      markAll();
    });

    resetBtn.addEventListener("click", resetGameToInitial);
    resetBtn2.addEventListener("click", resetGameToInitial);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!infoModal.classList.contains("hidden")) infoModal.classList.add("hidden");
      }
    });
  }

  // -------------------- Init --------------------
  function init() {
    initTopKeyboard();
    bindEvents();
    updatePageAdvice();
    resetGameToInitial();
  }

  init();
})();
