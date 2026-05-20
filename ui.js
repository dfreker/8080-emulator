// ============================================================
// UI Controller — 8080/8085 Emulator
// ============================================================

'use strict';

(function() {

  // ---- CodeMirror setup ------------------------------------

  // Define custom 8080/8085 syntax highlighting mode
  CodeMirror.defineMode('asm8080', function() {
    const MNEMONICS = new Set([
      'MOV','MVI','LXI','LDA','STA','LHLD','SHLD','LDAX','STAX','XCHG',
      'ADD','ADI','ADC','ACI','SUB','SUI','SBB','SBI','INR','DCR','INX','DCX','DAD','DAA',
      'ANA','ANI','ORA','ORI','XRA','XRI','CMP','CPI',
      'RLC','RRC','RAL','RAR','CMA','CMC','STC',
      'JMP','JNZ','JZ','JNC','JC','JPO','JPE','JP','JM',
      'CALL','CNZ','CZ','CNC','CC','CPO','CPE','CP','CM',
      'RET','RNZ','RZ','RNC','RC','RPO','RPE','RP','RM','PCHL','RST',
      'PUSH','POP','XTHL','SPHL',
      'IN','OUT','EI','DI','HLT','NOP','RIM','SIM'
    ]);
    const DIRECTIVES = new Set(['ORG','EQU','SET','DB','DW','DS','END','DEFB','DEFW','DEFS']);
    const REGISTERS  = new Set(['A','B','C','D','E','H','L','M','BC','DE','HL','SP','PSW']);

    return {
      startState() { return { inComment: false }; },
      token(stream, state) {
        if (stream.eatSpace()) return null;

        // Comment
        if (stream.peek() === ';') { stream.skipToEnd(); return 'asm-comment'; }

        // String
        if (stream.peek() === "'" || stream.peek() === '"') {
          const q = stream.next();
          while (!stream.eol() && stream.peek() !== q) stream.next();
          if (!stream.eol()) stream.next();
          return 'asm-string';
        }

        // Hex number: 0FFH, 0xAB, $FF
        if (stream.match(/^[0-9A-Fa-f]+[Hh]\b/) ||
            stream.match(/^0[Xx][0-9A-Fa-f]+/) ||
            stream.match(/^\$[0-9A-Fa-f]+/)) return 'asm-hex';

        // Binary: 1010B
        if (stream.match(/^[01]+[Bb]\b/)) return 'asm-number';

        // Decimal number
        if (stream.match(/^-?[0-9]+\b/)) return 'asm-number';

        // Word token (mnemonic, directive, register, or label)
        const word = stream.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
        if (word) {
          const up = word[0].toUpperCase();
          if (MNEMONICS.has(up))  return 'asm-mnemonic';
          if (DIRECTIVES.has(up)) return 'asm-directive';
          if (REGISTERS.has(up))  return 'asm-register';
          // Check if label (followed by : or at start of line context)
          if (stream.peek() === ':') { stream.next(); return 'asm-label'; }
          return 'asm-label'; // treat unknown identifiers as labels/symbols
        }

        stream.next();
        return null;
      }
    };
  });

  // Map mode token names to CSS classes
  CodeMirror.defineOption('mode', 'asm8080');

  // Custom token style mapper
  const TOKEN_CLASS_MAP = {
    'asm-mnemonic':  'cm-asm-mnemonic',
    'asm-register':  'cm-asm-register',
    'asm-label':     'cm-asm-label',
    'asm-comment':   'cm-asm-comment',
    'asm-hex':       'cm-asm-hex',
    'asm-number':    'cm-asm-number',
    'asm-directive': 'cm-asm-directive',
    'asm-string':    'cm-asm-string',
  };

  // Initialize CodeMirror
  const editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    mode: 'asm8080',
    theme: 'default',
    lineNumbers: true,
    lineWrapping: false,
    indentWithTabs: true,
    tabSize: 8,
    autofocus: true,
    styleActiveLine: true,
    gutters: ['CodeMirror-linenumbers', 'breakpoints'],
  });

  // Breakpoint gutter click — fires for any gutter column
  editor.on('gutterClick', (cm, lineNum, gutter) => {
    toggleBreakpoint(lineNum);
  });

  // ---- Sample programs -------------------------------------

  const SAMPLES = {

    fibonacci: `; ============================================
; Intel 8080/8085 Sample Program
; Fibonacci sequence — first 8 values in RAM
; Results stored starting at address 0100H
; ============================================

        ORG     0000H

START:
        LXI     SP, 0F000H  ; Initialize stack pointer
        LXI     H, 0100H    ; HL points to output buffer
        MVI     B, 08H      ; Generate 8 Fibonacci numbers
        MVI     D, 00H      ; Previous value (F[n-1])
        MVI     E, 01H      ; Current value (F[n])

LOOP:
        MOV     A, E        ; A = current
        MOV     M, A        ; Store in memory
        INX     H           ; Advance pointer

        ADD     D           ; A = F[n] + F[n-1]
        MOV     D, E        ; Old current becomes previous
        MOV     E, A        ; New current = sum

        DCR     B           ; Decrement counter
        JNZ     LOOP        ; Repeat if not zero

        ; Output results to console via port 01H
        LXI     H, 0100H    ; Reset pointer
        MVI     B, 08H      ; 8 values to print

PRINT:
        MOV     A, M        ; Load byte
        OUT     01H         ; Send to console port
        INX     H           ; Next byte
        DCR     B
        JNZ     PRINT

        HLT                 ; Done

        END
`,

    callret: `; ============================================
; Intel 8080/8085 Sample Program
; CALL / RET Demo
;
; Demonstrates subroutine calls using CALL
; and RET. The stack pointer is used to save
; and restore the return address automatically.
;
; Three subroutines are called in sequence:
;   DOUBLE  — multiplies A by 2
;   ADDTEN  — adds 10 to A
;   PRINTIT — outputs A to console port 01H
;
; Watch SP change as CALL pushes and RET pops
; the return address on the stack.
; ============================================

        ORG     0000H

START:
        LXI     SP, 0F000H  ; Set up stack pointer

        MVI     A, 05H      ; A = 5
        CALL    DOUBLE      ; A = 10  (5 * 2)
        CALL    ADDTEN      ; A = 20  (10 + 10)
        CALL    PRINTIT     ; Output 20 to console

        MVI     A, 03H      ; A = 3
        CALL    DOUBLE      ; A = 6   (3 * 2)
        CALL    DOUBLE      ; A = 12  (6 * 2)
        CALL    ADDTEN      ; A = 22  (12 + 10)
        CALL    PRINTIT     ; Output 22 to console

        HLT                 ; Done

; ---- Subroutine: DOUBLE ----------------------
; Multiplies register A by 2 (left shift by 1)
; Input:  A = value to double
; Output: A = value * 2
; Modifies: A, flags
DOUBLE:
        ADD     A           ; A = A + A  (same as A * 2)
        RET

; ---- Subroutine: ADDTEN ----------------------
; Adds 10 (0AH) to register A
; Input:  A = value
; Output: A = value + 10
; Modifies: A, flags
ADDTEN:
        ADI     0AH         ; A = A + 10
        RET

; ---- Subroutine: PRINTIT ---------------------
; Outputs register A to console port 01H
; Input:  A = value to print
; Output: none
; Modifies: nothing
PRINTIT:
        OUT     01H         ; Send A to console
        RET

        END
`
  };

  // ---- State -----------------------------------------------

  let assembled = false;
  let assemblyResult = null;
  let running = false;
  let runInterval = null;
  let prevState = null;
  let pendingInput = null;
  let inputResolve = null;
  let currentFilename = 'program.asm';
  let breakpoints = new Set();
  let savedStatus = null;

  const SPEED_MAP = { 1: 50, 2: 20, 3: 5, 4: 1, 5: 0 };
  const SPEED_LABELS = { 1: 'MIN', 2: 'SLOW', 3: 'MED', 4: 'FAST', 5: 'MAX' };

  // ---- DOM refs --------------------------------------------

  const btnAssemble = document.getElementById('btn-assemble');
  const btnRun      = document.getElementById('btn-run');
  const btnStep     = document.getElementById('btn-step');
  const btnReset    = document.getElementById('btn-reset');
  const btnGoto     = document.getElementById('btn-goto');
  const btnLoadSample   = document.getElementById('btn-load-sample');
  const btnLoadFile     = document.getElementById('btn-load-file');
  const btnSave         = document.getElementById('btn-save');
  const btnCopy         = document.getElementById('btn-copy');
  const btnClear        = document.getElementById('btn-clear');
  const btnClearConsole = document.getElementById('btn-clear-console');
  const sampleDropdown  = document.getElementById('sample-dropdown');
  const fileInput       = document.getElementById('file-input');
  const tabConsole      = document.getElementById('tab-console');
  const tabSymbols      = document.getElementById('tab-symbols');
  const consoleTab      = document.getElementById('console-tab');
  const symbolsTab      = document.getElementById('symbols-tab');
  const symbolTableBody = document.getElementById('symbol-table-body');
  const symbolTableEmpty= document.getElementById('symbol-table-empty');
  const symbolTable     = document.getElementById('symbol-table');
  const memAddrInput = document.getElementById('mem-addr');
  const memDump     = document.getElementById('mem-dump');
  const consoleOutput = document.getElementById('console-output');
  const consoleInput  = document.getElementById('console-input');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText  = document.getElementById('status-text');
  const errorPanel  = document.getElementById('error-panel');
  const errorList   = document.getElementById('error-list');
  const speedSlider = document.getElementById('speed-slider');
  const speedLabel  = document.getElementById('speed-label');

  // ---- Emulator callbacks ----------------------------------

  Emulator.setCallbacks({
    ioOutput(port, value) {
      if (port === 0x01) {
        // Print as decimal + hex
        consolePrint(`OUT[01]: ${value} (0x${value.toString(16).toUpperCase().padStart(2,'0')})`, 'console-line');
      } else if (port === 0x02) {
        // Print as ASCII character
        consolePrint(String.fromCharCode(value), 'console-line');
      } else {
        consolePrint(`OUT port 0x${port.toString(16).toUpperCase().padStart(2,'0')}: 0x${value.toString(16).toUpperCase().padStart(2,'0')}`, 'console-line info');
      }
    },
    ioInput(port) {
      const val = parseInt(pendingInput || '0', 16) || 0;
      consolePrint(`IN port 0x${port.toString(16).toUpperCase().padStart(2,'0')}: 0x${val.toString(16).toUpperCase().padStart(2,'0')}`, 'console-line info');
      return val;
    },
    onHalt() {
      stopRunning();
      setStatus('halt', 'HALTED');
      consolePrint('--- CPU HALTED ---', 'console-line sys');
    },
    onError(msg) {
      stopRunning();
      setStatus('error', 'ERROR');
      consolePrint(`ERROR: ${msg}`, 'console-line err');
    }
  });

  // ---- Assemble --------------------------------------------

  function assemble() {
    const source = editor.getValue();
    if (!source.trim()) return;

    const result = Assembler.assemble(source);
    assemblyResult = result;

    if (!result.success) {
      showErrors(result.errors);
      setStatus('error', 'ASSEMBLE ERROR');
      assembled = false;
      setControlsState(false);
      return;
    }

    hideErrors();
    setStatus('ok', `ASSEMBLED — ${Object.keys(result.symbols).length} SYMBOLS`);
    assembled = true;
    clearAllBreakpoints();
    renderSymbolTable(result.symbols);

    Emulator.loadProgram(result.bytes, result.origin);
    prevState = null;
    setControlsState(true);
    updateUI();
    renderMemory(result.origin);
    consolePrint(`Assembled OK. Entry: 0x${result.origin.toString(16).toUpperCase().padStart(4,'0')}`, 'console-line sys');
    consolePrint(`Symbols: ${Object.keys(result.symbols).join(', ') || 'none'}`, 'console-line sys');
  }

  // ---- Step ------------------------------------------------

  function stepOne() {
    if (!assembled) return;
    const state = Emulator.getState();
    if (state.halted) return;
    savePrevState();
    Emulator.step();
    updateUI();
    scrollMemoryToPC();
  }

  // ---- Run / Stop ------------------------------------------

  function runToggle() {
    if (!assembled) return;
    if (running) stopRunning();
    else startRunning();
  }

  function startRunning() {
    const state = Emulator.getState();
    if (state.halted) return;
    running = true;
    btnRun.textContent = '⏸ PAUSE';
    setStatus('run', 'RUNNING');

    const speed = parseInt(speedSlider.value);
    const delay = SPEED_MAP[speed];

    if (delay === 0) {
      // Max speed: burst mode
      function burst() {
        if (!running) return;
        const start = performance.now();
        let count = 0;
        while (running && count < 5000) {
          const s = Emulator.getState();
          if (s.halted) { stopRunning(); updateUI(); return; }
          Emulator.step();
          count++;
          if (checkBreakpoint()) return;
          if (performance.now() - start > 16) break;
        }
        updateUI();
        runInterval = requestAnimationFrame(burst);
      }
      runInterval = requestAnimationFrame(burst);
    } else {
      runInterval = setInterval(() => {
        const s = Emulator.getState();
        if (s.halted) { stopRunning(); updateUI(); return; }
        const stepsPerTick = speed >= 4 ? 10 : 1;
        for (let i = 0; i < stepsPerTick; i++) {
          if (Emulator.getState().halted) break;
          Emulator.step();
          if (checkBreakpoint()) return;
        }
        updateUI();
        scrollMemoryToPC();
      }, delay);
    }
  }

  function stopRunning() {
    running = false;
    btnRun.textContent = '▶▶ RUN';
    if (typeof runInterval === 'number') {
      clearInterval(runInterval);
      cancelAnimationFrame(runInterval);
    }
    runInterval = null;
    const s = Emulator.getState();
    if (!s.halted) setStatus('ok', 'PAUSED');
  }

  function resetEmulator() {
    stopRunning();
    if (assemblyResult && assemblyResult.success) {
      Emulator.loadProgram(assemblyResult.bytes, assemblyResult.origin);
      prevState = null;
      updateUI();
      renderMemory(assemblyResult.origin);
      setStatus('ok', 'RESET');
      consolePrint('--- RESET ---', 'console-line sys');
    }
  }

  // ---- UI update -------------------------------------------

  function updateUI() {
    const s = Emulator.getState();
    updateRegisters(s);
    updateFlags(s);
    updateCycles(s);
    highlightPCLine(s.PC);
    updateSymbolHighlight(s.PC);
    renderMemory();
    prevState = { A:s.A, B:s.B, C:s.C, D:s.D, E:s.E, H:s.H, L:s.L,
                  SP:s.SP, PC:s.PC,
                  flagS:s.flagS, flagZ:s.flagZ, flagAC:s.flagAC, flagP:s.flagP, flagCY:s.flagCY };
  }

  function savePrevState() {
    const s = Emulator.getState();
    prevState = { A:s.A, B:s.B, C:s.C, D:s.D, E:s.E, H:s.H, L:s.L,
                  SP:s.SP, PC:s.PC,
                  flagS:s.flagS, flagZ:s.flagZ, flagAC:s.flagAC, flagP:s.flagP, flagCY:s.flagCY };
  }

  function hex2(v) { return v.toString(16).toUpperCase().padStart(2,'0'); }
  function hex4(v) { return v.toString(16).toUpperCase().padStart(4,'0'); }

  function updateRegisters(s) {
    const regs = {
      A: [s.A, hex2(s.A)],
      B: [s.B, hex2(s.B)],
      C: [s.C, hex2(s.C)],
      D: [s.D, hex2(s.D)],
      E: [s.E, hex2(s.E)],
      H: [s.H, hex2(s.H)],
      L: [s.L, hex2(s.L)],
      SP: [s.SP, hex4(s.SP)],
      PC: [s.PC, hex4(s.PC)],
    };
    for (const [name, [val, display]] of Object.entries(regs)) {
      const el = document.getElementById(`val-${name}`);
      if (!el) continue;
      const prev = prevState ? prevState[name] : null;
      el.textContent = display;
      const cell = el.closest('.reg-cell');
      if (prev !== null && prev !== val) {
        cell.classList.add('changed');
        setTimeout(() => cell.classList.remove('changed'), 600);
      }
    }
  }

  function updateFlags(s) {
    const flags = { S: s.flagS, Z: s.flagZ, AC: s.flagAC, P: s.flagP, CY: s.flagCY };
    for (const [name, val] of Object.entries(flags)) {
      const el = document.getElementById(`flag-${name}`);
      if (el) el.classList.toggle('active', val === 1);
    }
  }

  function updateCycles(s) {
    document.getElementById('val-cycles').textContent = s.cycles.toLocaleString();
  }

  // ---- PC line highlight -----------------------------------

  let pcLineWidget = null;
  let lastPCLine = -1;

  function highlightPCLine(pc) {
    if (!assemblyResult || !assemblyResult.addrToLine) return;
    const lineNum = assemblyResult.addrToLine[pc];
    if (lineNum === undefined) {
      if (lastPCLine >= 0) {
        editor.removeLineClass(lastPCLine, 'background', 'cm-pc-line');
        lastPCLine = -1;
      }
      return;
    }
    if (lastPCLine >= 0 && lastPCLine !== lineNum) {
      editor.removeLineClass(lastPCLine, 'background', 'cm-pc-line');
    }
    editor.addLineClass(lineNum, 'background', 'cm-pc-line');
    lastPCLine = lineNum;
    // Scroll editor to keep PC line visible (only during step, not full run)
    if (!running) {
      editor.scrollIntoView({ line: lineNum, ch: 0 }, 80);
    }
  }

  // ---- Breakpoints -----------------------------------------

  function checkBreakpoint() {
    if (breakpoints.size === 0) return false;
    const s = Emulator.getState();
    if (!assemblyResult || !assemblyResult.addrToLine) return false;
    const lineNum = assemblyResult.addrToLine[s.PC];
    if (lineNum !== undefined && breakpoints.has(lineNum)) {
      stopRunning();
      updateUI();
      scrollMemoryToPC();
      setStatus('ok', `BREAKPOINT — LINE ${lineNum + 1}`);
      consolePrint(`Breakpoint hit at line ${lineNum + 1} (PC=0x${s.PC.toString(16).toUpperCase().padStart(4,'0')})`, 'console-line info');
      return true;
    }
    return false;
  }

  function toggleBreakpoint(lineNum) {
    // If already set, remove it
    if (breakpoints.has(lineNum)) {
      breakpoints.delete(lineNum);
      editor.setGutterMarker(lineNum, 'breakpoints', null);
      return;
    }

    // Require assembly before setting breakpoints
    if (!assembled || !assemblyResult || !assemblyResult.addrToLine) {
      editor.setGutterMarker(lineNum, 'breakpoints', makeMarker(true));
      setTimeout(() => editor.setGutterMarker(lineNum, 'breakpoints', null), 800);
      return;
    }

    // Check if this line number appears as a value in addrToLine
    const validLines = new Set(Object.values(assemblyResult.addrToLine));
    if (!validLines.has(lineNum)) {
      editor.setGutterMarker(lineNum, 'breakpoints', makeMarker(true));
      setTimeout(() => editor.setGutterMarker(lineNum, 'breakpoints', null), 800);
      return;
    }

    breakpoints.add(lineNum);
    editor.setGutterMarker(lineNum, 'breakpoints', makeMarker(false));
  }

  function makeMarker(invalid) {
    const dot = document.createElement('div');
    dot.className = invalid ? 'bp-marker bp-invalid' : 'bp-marker';
    dot.textContent = '●';
    dot.title = invalid ? 'No instruction on this line' : 'Breakpoint (click to remove)';
    return dot;
  }

  function clearAllBreakpoints() {
    breakpoints.forEach(lineNum => {
      editor.setGutterMarker(lineNum, 'breakpoints', null);
    });
    breakpoints.clear();
  }

  // ---- Memory dump -----------------------------------------

  const BYTES_PER_ROW = 8;
  const MEM_ROWS = 16;
  let memBase = 0;

  function renderMemory(base) {
    if (base !== undefined) memBase = base & 0xFFF0;
    const s = Emulator.getState();
    const frag = document.createDocumentFragment();

    for (let row = 0; row < MEM_ROWS; row++) {
      const addr = (memBase + row * BYTES_PER_ROW) & 0xFFFF;
      const rowEl = document.createElement('div');
      rowEl.className = 'mem-row';

      const addrEl = document.createElement('span');
      addrEl.className = 'mem-addr-col';
      addrEl.textContent = hex4(addr) + ':';
      rowEl.appendChild(addrEl);

      const bytesEl = document.createElement('div');
      bytesEl.className = 'mem-bytes';

      let ascii = '';
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const a = (addr + i) & 0xFFFF;
        const b = s.mem[a];
        const byteEl = document.createElement('span');
        byteEl.className = 'mem-byte';
        byteEl.textContent = hex2(b);

        if (a === s.PC) byteEl.classList.add('pc-byte');
        else if (a === s.SP) byteEl.classList.add('sp-byte');
        else if (b !== 0) byteEl.classList.add('nonzero');

        bytesEl.appendChild(byteEl);
        ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
      }

      const asciiEl = document.createElement('span');
      asciiEl.className = 'mem-ascii';
      asciiEl.textContent = ascii;

      rowEl.appendChild(bytesEl);
      rowEl.appendChild(asciiEl);
      frag.appendChild(rowEl);
    }

    memDump.innerHTML = '';
    memDump.appendChild(frag);
  }

  function scrollMemoryToPC() {
    const s = Emulator.getState();
    memBase = s.PC & 0xFFF0;
    renderMemory();
  }

  // ---- Console ---------------------------------------------

  function consolePrint(text, cls) {
    const line = document.createElement('div');
    line.className = cls || 'console-line';
    line.textContent = text;
    consoleOutput.appendChild(line);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  // ---- Status ----------------------------------------------

  function setStatus(type, text) {
    statusIndicator.className = `status-${type}`;
    statusText.textContent = text;
  }

  // ---- Symbol table ----------------------------------------

  let symSortCol = 'addr'; // 'name' or 'addr'
  let symSortAsc = true;

  function renderSymbolTable(symbols) {
    symbolTableBody.innerHTML = '';
    const entries = Object.entries(symbols);
    if (entries.length === 0) {
      symbolTableEmpty.style.display = 'block';
      symbolTable.style.display = 'none';
      return;
    }
    symbolTableEmpty.style.display = 'none';
    symbolTable.style.display = 'table';
    sortAndPopulate(entries);
    updateSortHeaders();
  }

  function sortAndPopulate(entries) {
    if (!entries) {
      if (!assemblyResult || !assemblyResult.symbols) return;
      entries = Object.entries(assemblyResult.symbols);
    }
    entries.sort((a, b) => {
      let cmp = symSortCol === 'name'
        ? a[0].localeCompare(b[0])
        : a[1] - b[1];
      return symSortAsc ? cmp : -cmp;
    });

    symbolTableBody.innerHTML = '';
    entries.forEach(([name, val]) => {
      const tr = document.createElement('tr');
      tr.dataset.addr = val;
      tr.innerHTML = `
        <td class="sym-name">${name}</td>
        <td class="sym-addr">${hex4(val)}</td>
      `;
      symbolTableBody.appendChild(tr);
    });

    // Re-apply PC highlight
    const s = Emulator.getState();
    updateSymbolHighlight(s.PC);
  }

  function updateSortHeaders() {
    const nameHdr = document.getElementById('sort-name');
    const addrHdr = document.getElementById('sort-addr');
    nameHdr.classList.toggle('sort-active', symSortCol === 'name');
    addrHdr.classList.toggle('sort-active', symSortCol === 'addr');
    nameHdr.querySelector('.sort-arrow').textContent = symSortCol === 'name' ? (symSortAsc ? '▲' : '▼') : '';
    addrHdr.querySelector('.sort-arrow').textContent = symSortCol === 'addr' ? (symSortAsc ? '▲' : '▼') : '';
  }

  // Sort header click handlers
  document.getElementById('sort-name').addEventListener('click', () => {
    if (symSortCol === 'name') symSortAsc = !symSortAsc;
    else { symSortCol = 'name'; symSortAsc = true; }
    sortAndPopulate();
    updateSortHeaders();
  });

  document.getElementById('sort-addr').addEventListener('click', () => {
    if (symSortCol === 'addr') symSortAsc = !symSortAsc;
    else { symSortCol = 'addr'; symSortAsc = true; }
    sortAndPopulate();
    updateSortHeaders();
  });

  function updateSymbolHighlight(pc) {
    if (!assemblyResult || !assemblyResult.symbols) return;
    document.querySelectorAll('#symbol-table-body tr').forEach(tr => {
      const addr = parseInt(tr.dataset.addr);
      tr.classList.toggle('sym-active', addr === pc);
    });
  }

  function clearSymbolTable() {
    symbolTableBody.innerHTML = '';
    symbolTableEmpty.style.display = 'block';
    symbolTable.style.display = 'none';
    symSortCol = 'addr';
    symSortAsc = true;
    updateSortHeaders();
  }

  // ---- Tab switching ---------------------------------------

  tabConsole.addEventListener('click', () => {
    tabConsole.classList.add('active');
    tabSymbols.classList.remove('active');
    consoleTab.classList.remove('hidden');
    symbolsTab.classList.add('hidden');
    btnClearConsole.style.visibility = '';
  });

  tabSymbols.addEventListener('click', () => {
    tabSymbols.classList.add('active');
    tabConsole.classList.remove('active');
    symbolsTab.classList.remove('hidden');
    consoleTab.classList.add('hidden');
    btnClearConsole.style.visibility = 'hidden';
    // Update highlight when switching to symbols tab
    const s = Emulator.getState();
    updateSymbolHighlight(s.PC);
  });

  // ---- Errors ----------------------------------------------

  function showErrors(errors) {
    errorPanel.classList.remove('hidden');
    errorList.innerHTML = '';
    errors.forEach(e => {
      const div = document.createElement('div');
      div.className = 'error-line';
      div.innerHTML = `<span class="err-loc">Line ${e.line}:</span><span class="err-msg">${e.msg}</span>`;
      errorList.appendChild(div);
    });
  }

  function hideErrors() {
    errorPanel.classList.add('hidden');
    errorList.innerHTML = '';
  }

  // ---- Controls state --------------------------------------

  function setControlsState(ready) {
    btnRun.disabled   = !ready;
    btnStep.disabled  = !ready;
    btnReset.disabled = !ready;
  }

  // ---- Event listeners -------------------------------------

  btnAssemble.addEventListener('click', assemble);
  btnRun.addEventListener('click', runToggle);
  btnStep.addEventListener('click', stepOne);
  btnReset.addEventListener('click', resetEmulator);

  // ---- LOAD SAMPLE dropdown --------------------------------

  btnLoadSample.addEventListener('click', (e) => {
    e.stopPropagation();
    sampleDropdown.classList.toggle('hidden');
  });

  document.querySelectorAll('.sample-item').forEach(item => {
    item.addEventListener('click', () => {
      const key = item.dataset.sample;
      const src = SAMPLES[key];
      if (!src) return;
      if (editor.getValue().trim() && !confirm('Replace current code with sample program?')) return;
      editor.setValue(src);
      currentFilename = key + '.asm';
      hideErrors();
      assembled = false;
      setControlsState(false);
      setStatus('idle', 'READY');
      sampleDropdown.classList.add('hidden');
    });
  });

  // Close dropdown if user clicks anywhere else
  document.addEventListener('click', () => {
    sampleDropdown.classList.add('hidden');
  });

  // ---- LOAD FILE -------------------------------------------

  btnLoadFile.addEventListener('click', () => {
    fileInput.value = ''; // reset so same file can be reloaded
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      editor.setValue(e.target.result);
      currentFilename = file.name;
      hideErrors();
      assembled = false;
      setControlsState(false);
      setStatus('idle', 'READY');
      consolePrint(`Loaded: ${file.name}`, 'console-line sys');
    };
    reader.readAsText(file);
  });

  // ---- SAVE ------------------------------------------------

  btnSave.addEventListener('click', () => {
    const source = editor.getValue();
    if (!source.trim()) return;
    const blob = new Blob([source], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = currentFilename;
    a.click();
    URL.revokeObjectURL(url);
    consolePrint(`Saved: ${currentFilename}`, 'console-line sys');
  });

  // ---- COPY ------------------------------------------------

  btnCopy.addEventListener('click', () => {
    const source = editor.getValue();
    if (!source.trim()) return;
    navigator.clipboard.writeText(source).then(() => {
      btnCopy.textContent = 'COPIED \u2713';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = 'COPY';
        btnCopy.classList.remove('copied');
      }, 1500);
    });
  });

  // ---- CLEAR -----------------------------------------------

  btnClear.addEventListener('click', () => {
    if (editor.getValue().trim() && !confirm('Clear the editor?')) return;
    editor.setValue('');
    currentFilename = 'program.asm';
    hideErrors();
    clearSymbolTable();
    assembled = false;
    assemblyResult = null;
    Emulator.reset();
    prevState = null;
    memBase = 0;
    setControlsState(false);
    setStatus('idle', 'READY');
    updateUI();
  });

  btnClearConsole.addEventListener('click', () => { consoleOutput.innerHTML = ''; });

  btnGoto.addEventListener('click', () => {
    const addr = parseInt(memAddrInput.value, 16);
    if (!isNaN(addr)) {
      memBase = addr & 0xFFF0;
      renderMemory();
    }
  });

  memAddrInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnGoto.click();
  });

  speedSlider.addEventListener('input', function() {
    speedLabel.textContent = SPEED_LABELS[this.value];
    if (running) { stopRunning(); startRunning(); }
  });

  consoleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      pendingInput = consoleInput.value;
      consoleInput.value = '';
    }
  });

  // ---- Init ------------------------------------------------

  setStatus('idle', 'READY');
  setControlsState(false);
  renderMemory(0);
  editor.setValue(SAMPLES.fibonacci);
  editor.refresh();

  // Status bar hint on gutter hover
  setTimeout(() => {
    const oldTip = document.getElementById('gutter-tooltip');
    if (oldTip) oldTip.remove();

    function onGutterEnter() {
      if (savedStatus) return; // already showing hint
      savedStatus = { cls: statusIndicator.className, text: statusText.innerHTML };
      statusText.innerHTML = 'Click line number to<br>set / clear breakpoint';
    }
    function onGutterLeave(e) {
      // Only restore if we're leaving the entire gutters zone
      const guttersEl = document.querySelector('.CodeMirror-gutters');
      if (guttersEl && guttersEl.contains(e.relatedTarget)) return;
      if (savedStatus) {
        statusIndicator.className = savedStatus.cls;
        statusText.innerHTML = savedStatus.text;
        savedStatus = null;
      }
    }

    // Attach to the gutters container AND every child gutter element
    const targets = document.querySelectorAll(
      '.CodeMirror-gutters, .CodeMirror-gutter, .CodeMirror-linenumbers, .CodeMirror-linenumber'
    );
    targets.forEach(el => {
      el.addEventListener('mouseenter', onGutterEnter);
      el.addEventListener('mouseleave', onGutterLeave);
    });

    // Also re-attach when new line number elements are created (CodeMirror renders them dynamically)
    editor.on('update', () => {
      document.querySelectorAll('.CodeMirror-linenumber:not([data-bp-listener])').forEach(el => {
        el.setAttribute('data-bp-listener', '1');
        el.addEventListener('mouseenter', onGutterEnter);
        el.addEventListener('mouseleave', onGutterLeave);
      });
    });
  }, 300);

  consolePrint('8080/8085 Emulator ready. Press ASSEMBLE to begin.', 'console-line sys');
  consolePrint('I/O: OUT port 01H prints byte value. OUT port 02H prints ASCII.', 'console-line sys');
  consolePrint('After assembly, click a line number to set or clear a breakpoint.', 'console-line sys');

})();
