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

  // ============================================================
  // Multi-file tab management
  // ============================================================

  let files = [];        // Array of { id, filename, cm, isMain }
  let activeFileId = null;
  let nextFileId = 1;

  function createCodeMirror(container) {
    const cm = CodeMirror(container, {
      mode: 'asm8080',
      theme: 'default',
      lineNumbers: true,
      lineWrapping: false,
      indentWithTabs: true,
      tabSize: 8,
      styleActiveLine: true,
      gutters: ['CodeMirror-linenumbers', 'breakpoints'],
    });

    // Breakpoint gutter click
    cm.on('gutterClick', (cm, lineNum) => {
      if (getActiveFile() && getActiveFile().cm === cm) {
        toggleBreakpoint(lineNum);
      }
    });

    return cm;
  }

  function getActiveFile() {
    return files.find(f => f.id === activeFileId) || null;
  }

  function getMainFile() {
    return files.find(f => f.isMain) || files[0] || null;
  }

  function fileResolver(filename) {
    const f = files.find(f => f.filename.toLowerCase() === filename.toLowerCase());
    return f ? f.cm.getValue() : null;
  }

  function addFile(filename, content, makeMain) {
    const id = nextFileId++;
    const wrap = document.createElement('div');
    wrap.className = 'file-editor-wrap';
    wrap.dataset.fileId = id;
    document.getElementById('editor-container').appendChild(wrap);

    const cm = createCodeMirror(wrap);
    if (content) cm.setValue(content);

    const file = {
      id,
      filename: filename || `untitled${id}.asm`,
      cm,
      isMain: makeMain || files.length === 0,
      wrap,
    };

    files.push(file);
    renderFileTabs();
    switchToFile(id);

    // Set up gutter tooltip for new editor
    setTimeout(() => {
      setupGutterTooltip(cm);
    }, 100);

    return file;
  }

  function removeFile(id) {
    if (files.length <= 1) {
      // Don't close the last file — just clear it
      const f = files[0];
      f.cm.setValue('');
      f.filename = 'untitled1.asm';
      f.isMain = true;
      renderFileTabs();
      return;
    }

    const idx = files.findIndex(f => f.id === id);
    if (idx === -1) return;

    const f = files[idx];
    f.wrap.remove();
    files.splice(idx, 1);

    // If removed file was main, make first file main
    if (f.isMain && files.length > 0) files[0].isMain = true;

    // Switch to adjacent file
    const newActive = files[Math.min(idx, files.length - 1)];
    renderFileTabs();
    switchToFile(newActive.id);
  }

  function switchToFile(id) {
    activeFileId = id;
    files.forEach(f => {
      f.wrap.classList.toggle('active', f.id === id);
    });
    renderFileTabs();

    // Refresh CodeMirror for the active file
    const f = files.find(f => f.id === id);
    if (f) {
      setTimeout(() => { f.cm.refresh(); f.cm.focus(); }, 10);
    }

    // Re-setup gutter tooltip for active editor
    setTimeout(() => {
      if (f) setupGutterTooltip(f.cm);
    }, 150);
  }

  function setMainFile(id) {
    files.forEach(f => f.isMain = f.id === id);
    renderFileTabs();
  }

  function renderFileTabs() {
    const tabsEl = document.getElementById('file-tabs');
    tabsEl.innerHTML = '';

    files.forEach(f => {
      const tab = document.createElement('div');
      tab.className = 'file-tab' +
        (f.id === activeFileId ? ' active' : '') +
        (f.isMain ? ' is-main' : '');
      tab.dataset.fileId = f.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tab-filename';
      nameSpan.textContent = f.filename;
      nameSpan.title = f.isMain ? `${f.filename} (MAIN)` : f.filename;

      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close file';

      tab.appendChild(nameSpan);
      tab.appendChild(closeBtn);
      tabsEl.appendChild(tab);

      // Click tab to switch
      tab.addEventListener('click', (e) => {
        if (e.target === closeBtn) return;
        switchToFile(f.id);
      });

      // Double-click filename to rename
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(f.id, nameSpan, tab);
      });

      // Close button
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (files.length > 1 && !confirm(`Close "${f.filename}"?`)) return;
        removeFile(f.id);
      });

      // Right-click context menu
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTabContextMenu(e, f.id);
      });
    });
  }

  function startRename(id, nameSpan, tab) {
    const f = files.find(f => f.id === id);
    if (!f) return;

    const input = document.createElement('input');
    input.className = 'tab-filename-input';
    input.value = f.filename;
    tab.replaceChild(input, nameSpan);
    input.focus();
    input.select();

    function confirmRename() {
      let newName = input.value.trim();
      if (!newName) newName = f.filename;
      // Ensure .asm extension
      if (!newName.match(/\.(asm|s|txt)$/i)) newName += '.asm';
      // Check for duplicates
      const duplicate = files.find(other => other.id !== id && other.filename.toLowerCase() === newName.toLowerCase());
      if (duplicate) {
        consolePrint(`Filename "${newName}" already exists.`, 'console-line err');
        newName = f.filename;
      }
      f.filename = newName;
      renderFileTabs();
    }

    input.addEventListener('blur', confirmRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
      if (e.key === 'Escape') { e.preventDefault(); f.filename = f.filename; renderFileTabs(); }
    });
  }

  // Tab context menu
  let contextMenuEl = null;

  function showTabContextMenu(e, fileId) {
    hideContextMenu();
    const f = files.find(f => f.id === fileId);
    if (!f) return;

    const menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';

    const items = [
      { label: f.isMain ? '★ MAIN FILE (current)' : 'Set as MAIN file', cls: f.isMain ? 'ctx-active' : '', action: () => setMainFile(fileId) },
      { label: 'Rename', action: () => {
        const tab = document.querySelector(`.file-tab[data-file-id="${fileId}"]`);
        const nameSpan = tab ? tab.querySelector('.tab-filename') : null;
        if (tab && nameSpan) startRename(fileId, nameSpan, tab);
      }},
      { label: 'Close', cls: 'ctx-danger', action: () => {
        if (files.length > 1 && !confirm(`Close "${f.filename}"?`)) return;
        removeFile(fileId);
      }},
    ];

    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'ctx-menu-item' + (item.cls ? ' ' + item.cls : '');
      div.textContent = item.label;
      div.addEventListener('click', () => { hideContextMenu(); item.action(); });
      menu.appendChild(div);
    });

    document.body.appendChild(menu);
    contextMenuEl = menu;

    document.addEventListener('click', hideContextMenu, { once: true });
  }

  function hideContextMenu() {
    if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
  }

  // + New file button
  document.getElementById('btn-new-file').addEventListener('click', () => {
    addFile(`untitled${nextFileId}.asm`, '', false);
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

  SAMPLES.helloworld = `; ============================================
; Intel 8080/8085 Sample Program
; Hello World — Data Table Demo
;
; Demonstrates DB directives and data memory.
; A string "Hello World!" is stored in memory
; using DB directives starting at address 0200H.
;
; The program reads each character byte by byte
; and outputs it to the console via port 02H
; which prints ASCII characters.
;
; Switch to the DATA tab in the memory panel
; after assembling to see the string sitting
; in memory. Watch it output character by
; character as you step through the code.
; ============================================

        ORG     0000H

START:
        LXI     SP, 0F000H  ; Initialize stack pointer
        LXI     H, MSG      ; HL points to message
        MVI     B, MSGLEN   ; B = message length

LOOP:
        MOV     A, M        ; Load character from memory
        OUT     02H         ; Output as ASCII to console
        INX     H           ; Advance pointer to next char
        DCR     B           ; Decrement counter
        JNZ     LOOP        ; Repeat until all chars sent

        HLT                 ; Done

; ============================================
; Data section — stored at 0200H
; Switch to DATA tab to see these bytes
; ============================================

        ORG     0200H

MSGLEN  EQU     14          ; Length of message (12 chars + CR + LF)

MSG:    DB      'Hello World!', 0DH, 0AH  ; CR+LF line ending

        END
`;

  // ---- State -----------------------------------------------

  let assembled = false;
  let assemblyResult = null;
  let running = false;
  let runInterval = null;
  let prevState = null;
  let pendingInput = null;
  let inputResolve = null;
  let breakpoints = new Set();
  let savedStatus = null;
  let activeMemTab = 'code'; // 'code', 'data', 'stack'
  let dataBase = 0x0100;     // default data base address
  let autoDataBase = null;   // auto-detected data address from assembly

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
  const memAddrInput    = document.getElementById('mem-addr');
  const memAddrControls = document.getElementById('mem-addr-controls');
  const memTabLabel     = document.getElementById('mem-tab-label');
  const memTabCode      = document.getElementById('mem-tab-code');
  const memTabData      = document.getElementById('mem-tab-data');
  const memTabStack     = document.getElementById('mem-tab-stack');
  const memDump         = document.getElementById('mem-dump');
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
        // Print as ASCII character — accumulate into current line
        // CR (0DH) and LF (0AH) both trigger a new line
        if (value === 0x0A || value === 0x0D) {
          // Start a new ascii-out line on next character
          const sentinel = document.createElement('div');
          sentinel.className = 'console-line ascii-sentinel';
          consoleOutput.appendChild(sentinel);
          consoleOutput.scrollTop = consoleOutput.scrollHeight;
        } else {
          const char = String.fromCharCode(value);
          // Find last non-sentinel ascii line
          const lines = consoleOutput.querySelectorAll('.console-line.ascii-out');
          let lastLine = lines[lines.length - 1];
          // Check if there's a sentinel after the last ascii-out line
          const lastSentinel = consoleOutput.querySelector('.ascii-sentinel:last-child');
          if (!lastLine || lastSentinel) {
            lastLine = document.createElement('div');
            lastLine.className = 'console-line ascii-out';
            consoleOutput.appendChild(lastLine);
          }
          lastLine.textContent += char;
          consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }
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
    const mainFile = getMainFile();
    if (!mainFile) return;
    const source = mainFile.cm.getValue();
    if (!source.trim()) return;

    const result = Assembler.assemble(source, fileResolver);
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

    // Auto-detect data region from DB/DW/DS directives
    autoDataBase = null;
    if (result.dataAddresses && result.dataAddresses.length > 0) {
      autoDataBase = Math.min(...result.dataAddresses);
    }

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
      // Force next ascii output to start on a fresh line
      const sentinel = document.createElement('div');
      sentinel.className = 'console-line ascii-sentinel';
      consoleOutput.appendChild(sentinel);
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
    scrollMemoryToPC();
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
  let lastPCEditor = null;

  function highlightPCLine(pc) {
    if (!assemblyResult || !assemblyResult.addrToLine) return;
    const mainFile = getMainFile();
    if (!mainFile) return;
    const cm = mainFile.cm;
    const lineNum = assemblyResult.addrToLine[pc];

    if (lineNum === undefined) {
      if (lastPCLine >= 0 && lastPCEditor) {
        lastPCEditor.removeLineClass(lastPCLine, 'background', 'cm-pc-line');
        lastPCLine = -1;
        lastPCEditor = null;
      }
      return;
    }
    if (lastPCLine >= 0 && lastPCEditor && (lastPCLine !== lineNum || lastPCEditor !== cm)) {
      lastPCEditor.removeLineClass(lastPCLine, 'background', 'cm-pc-line');
    }
    cm.addLineClass(lineNum, 'background', 'cm-pc-line');
    lastPCLine = lineNum;
    lastPCEditor = cm;

    // Switch to main file tab if not already there and scroll to PC line
    if (!running) {
      if (activeFileId !== mainFile.id) switchToFile(mainFile.id);
      cm.scrollIntoView({ line: lineNum, ch: 0 }, 80);
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
    const f = getActiveFile();
    if (!f) return;
    const cm = f.cm;

    if (breakpoints.has(lineNum)) {
      breakpoints.delete(lineNum);
      cm.setGutterMarker(lineNum, 'breakpoints', null);
      return;
    }

    if (!assembled || !assemblyResult || !assemblyResult.addrToLine) {
      cm.setGutterMarker(lineNum, 'breakpoints', makeMarker(true));
      setTimeout(() => cm.setGutterMarker(lineNum, 'breakpoints', null), 800);
      return;
    }

    const validLines = new Set(Object.values(assemblyResult.addrToLine));
    if (!validLines.has(lineNum)) {
      cm.setGutterMarker(lineNum, 'breakpoints', makeMarker(true));
      setTimeout(() => cm.setGutterMarker(lineNum, 'breakpoints', null), 800);
      return;
    }

    breakpoints.add(lineNum);
    cm.setGutterMarker(lineNum, 'breakpoints', makeMarker(false));
  }

  function makeMarker(invalid) {
    const dot = document.createElement('div');
    dot.className = invalid ? 'bp-marker bp-invalid' : 'bp-marker';
    dot.textContent = '●';
    dot.title = invalid ? 'No instruction on this line' : 'Breakpoint (click to remove)';
    return dot;
  }

  function clearAllBreakpoints() {
    files.forEach(f => {
      breakpoints.forEach(lineNum => {
        f.cm.setGutterMarker(lineNum, 'breakpoints', null);
      });
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

    // Determine effective base address based on active tab
    let effectiveBase = memBase;
    if (activeMemTab === 'stack') {
      effectiveBase = memBase; // set by scrollMemoryToPC for stack
    }

    for (let row = 0; row < MEM_ROWS; row++) {
      const addr = (effectiveBase + row * BYTES_PER_ROW) & 0xFFFF;
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

        if (activeMemTab === 'code') {
          if (a === s.PC) byteEl.classList.add('pc-byte');
          else if (b !== 0) byteEl.classList.add('nonzero');
        } else if (activeMemTab === 'stack') {
          if (a === s.SP) byteEl.classList.add('sp-byte');
          else if (a > s.SP) byteEl.classList.add('stack-active'); // on the stack
          else byteEl.classList.add('stack-below');                // below SP
        } else {
          // DATA tab
          if (b !== 0) byteEl.classList.add('nonzero');
        }

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

    if (activeMemTab === 'code') {
      const pc = s.PC;
      const pcRow = Math.floor((pc - memBase) / BYTES_PER_ROW);
      const ZONE_TOP    = 3;
      const ZONE_BOTTOM = 12;
      if (pcRow >= ZONE_TOP && pcRow <= ZONE_BOTTOM) {
        renderMemory();
        return;
      }
      const targetRow = 6;
      const newBase = pc - (targetRow * BYTES_PER_ROW);
      memBase = Math.max(0, newBase) & 0xFFF0;
      renderMemory();

    } else if (activeMemTab === 'stack') {
      // Always follow SP — keep it near row 6
      const sp = s.SP;
      const spRow = Math.floor((sp - memBase) / BYTES_PER_ROW);
      const ZONE_TOP    = 3;
      const ZONE_BOTTOM = 12;
      if (spRow < ZONE_TOP || spRow > ZONE_BOTTOM) {
        const targetRow = 6;
        const newBase = sp - (targetRow * BYTES_PER_ROW);
        memBase = Math.max(0, newBase) & 0xFFF0;
      }
      renderMemory();

    } else {
      // DATA tab — stay put, just re-render to reflect updated values
      renderMemory();
    }
  }

  // ---- Memory tab switching --------------------------------

  function setMemTab(tab) {
    activeMemTab = tab;
    memTabCode.classList.toggle('active', tab === 'code');
    memTabData.classList.toggle('active', tab === 'data');
    memTabStack.classList.toggle('active', tab === 'stack');

    if (tab === 'code') {
      memAddrControls.style.visibility = 'visible';
      memTabLabel.classList.add('hidden');
      scrollMemoryToPC();

    } else if (tab === 'data') {
      memAddrControls.style.visibility = 'visible';
      if (autoDataBase !== null) {
        memBase = autoDataBase & 0xFFF0;
        memAddrInput.value = hex4(autoDataBase);
        memTabLabel.textContent = `AUTO-DETECTED DATA: ${hex4(autoDataBase)}H`;
        memTabLabel.classList.remove('hidden');
      } else {
        memBase = dataBase & 0xFFF0;
        memAddrInput.value = hex4(dataBase);
        memTabLabel.classList.add('hidden');
      }
      renderMemory();

    } else if (tab === 'stack') {
      memAddrControls.style.visibility = 'hidden';
      memTabLabel.classList.add('hidden');
      const s = Emulator.getState();
      const targetRow = 6;
      const newBase = s.SP - (targetRow * BYTES_PER_ROW);
      memBase = Math.max(0, newBase) & 0xFFF0;
      renderMemory();
    }
  }

  memTabCode.addEventListener('click',  () => setMemTab('code'));
  memTabData.addEventListener('click',  () => setMemTab('data'));
  memTabStack.addEventListener('click', () => setMemTab('stack'));

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

      // For Hello World, load two files: main.asm and the data
      // For others, load into main file
      if (confirm('Load sample? This will replace all current files.')) {
        clearAllFiles();
        if (key === 'helloworld') {
          // Split into two files for demonstration
          addFile('main.asm', src, true);
        } else {
          addFile('main.asm', src, true);
        }
        hideErrors();
        assembled = false;
        setControlsState(false);
        setStatus('idle', 'READY');
      }
      sampleDropdown.classList.add('hidden');
    });
  });

  // Close dropdown if user clicks anywhere else
  document.addEventListener('click', () => {
    sampleDropdown.classList.add('hidden');
  });

  // ---- LOAD FILE -------------------------------------------

  btnLoadFile.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      // Check if a file with this name already exists
      const existing = files.find(f => f.filename.toLowerCase() === file.name.toLowerCase());
      if (existing) {
        existing.cm.setValue(e.target.result);
        switchToFile(existing.id);
      } else {
        addFile(file.name, e.target.result, files.length === 0);
      }
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
    const f = getActiveFile();
    if (!f) return;
    const source = f.cm.getValue();
    if (!source.trim()) return;
    const blob = new Blob([source], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = f.filename;
    a.click();
    URL.revokeObjectURL(url);
    consolePrint(`Saved: ${f.filename}`, 'console-line sys');
  });

  // ---- COPY ------------------------------------------------

  btnCopy.addEventListener('click', () => {
    const f = getActiveFile();
    if (!f) return;
    const source = f.cm.getValue();
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

  // ---- CLEAR ALL -------------------------------------------

  btnClear.addEventListener('click', () => {
    if (!confirm('Clear all files and reset?')) return;
    clearAllFiles();
    hideErrors();
    clearSymbolTable();
    assembled = false;
    autoDataBase = null;
    activeMemTab = 'code';
    setMemTab('code');
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
      if (activeMemTab === 'data') {
        dataBase = addr;
        autoDataBase = null; // manual override clears auto
        memTabLabel.classList.add('hidden');
      }
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

  // ---- Panel resizer ---------------------------------------

  const resizer      = document.getElementById('panel-resizer');
  const consolePanel = document.getElementById('console-panel');
  const MIN_HEIGHT   = 140;
  const MAX_HEIGHT   = 400;

  // Restore saved height
  const savedHeight = parseInt(localStorage.getItem('consolePanelHeight'));
  if (savedHeight && savedHeight >= MIN_HEIGHT && savedHeight <= MAX_HEIGHT) {
    consolePanel.style.height = savedHeight + 'px';
  } else {
    consolePanel.style.height = MIN_HEIGHT + 'px';
  }

  let dragStartY = 0;
  let dragStartHeight = 0;
  let isHovering = false;

  // Manage highlight purely through JS to avoid Safari stuck :hover
  resizer.addEventListener('mouseenter', () => {
    isHovering = true;
    resizer.style.background = 'var(--green-dim)';
  });

  resizer.addEventListener('mouseleave', () => {
    isHovering = false;
    if (!resizer.classList.contains('dragging')) {
      resizer.style.background = '';
    }
  });

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartHeight = consolePanel.offsetHeight;
    resizer.classList.add('dragging');
    resizer.style.background = 'var(--green-dim)';
    document.body.style.cursor = 'row-resize';
    document.body.classList.add('no-select');

    function onMouseMove(e) {
      e.preventDefault();
      const delta = dragStartY - e.clientY;
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartHeight + delta));
      consolePanel.style.height = newHeight + 'px';
    }

    function onMouseUp() {
      resizer.classList.remove('dragging');
      // Only keep highlight if mouse is still physically over the resizer
      if (!isHovering) {
        resizer.style.background = '';
      }
      document.body.style.cursor = '';
      document.body.classList.remove('no-select');
      localStorage.setItem('consolePanelHeight', consolePanel.offsetHeight);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ---- Helpers ---------------------------------------------

  function clearAllFiles() {
    // Remove all editor wraps
    files.forEach(f => f.wrap.remove());
    files = [];
    activeFileId = null;
    nextFileId = 1;
    renderFileTabs();
  }

  function setupGutterTooltip(cm) {
    function onGutterEnter() {
      if (savedStatus) return;
      savedStatus = { cls: statusIndicator.className, text: statusText.innerHTML };
      statusText.innerHTML = 'Click line number to<br>set / clear breakpoint';
    }
    function onGutterLeave(e) {
      const guttersEl = cm.getWrapperElement().querySelector('.CodeMirror-gutters');
      if (guttersEl && guttersEl.contains(e.relatedTarget)) return;
      if (savedStatus) {
        statusIndicator.className = savedStatus.cls;
        statusText.innerHTML = savedStatus.text;
        savedStatus = null;
      }
    }

    const wrap = cm.getWrapperElement();
    wrap.querySelectorAll('.CodeMirror-gutters, .CodeMirror-gutter, .CodeMirror-linenumbers').forEach(el => {
      el.addEventListener('mouseenter', onGutterEnter);
      el.addEventListener('mouseleave', onGutterLeave);
    });

    cm.on('update', () => {
      wrap.querySelectorAll('.CodeMirror-linenumber:not([data-bp-listener])').forEach(el => {
        el.setAttribute('data-bp-listener', '1');
        el.addEventListener('mouseenter', onGutterEnter);
        el.addEventListener('mouseleave', onGutterLeave);
      });
    });
  }

  // ---- Init ------------------------------------------------

  setStatus('idle', 'READY');
  setControlsState(false);
  renderMemory(0);

  // Create initial empty file
  addFile('main.asm', '', true);

  consolePrint('8080/8085 Emulator ready. Press ASSEMBLE to begin.', 'console-line sys');
  consolePrint('I/O: OUT port 01H prints byte value. OUT port 02H prints ASCII.', 'console-line sys');
  consolePrint('After assembly, click a line number to set or clear a breakpoint.', 'console-line sys');
  consolePrint('Tip: right-click a file tab to set it as MAIN or rename it.', 'console-line sys');

})();
