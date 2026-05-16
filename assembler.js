// ============================================================
// Intel 8080/8085 Two-Pass Assembler
// ============================================================

'use strict';

const Assembler = (() => {

  // ---- Opcode table ----------------------------------------
  // Format: mnemonic -> function(operands) -> [bytes...]
  // Returns null on error, throws string on bad operand

  const REG8 = { A:7, B:0, C:1, D:2, E:3, H:4, L:5, M:6 };
  const REG16_BC_DE_HL_SP = { BC:0, B:0, DE:1, D:1, HL:2, H:2, SP:3 };
  const REG16_BC_DE_HL_PSW = { BC:0, B:0, DE:1, D:1, HL:2, H:2, PSW:3 };
  const RST_VECS = [0,1,2,3,4,5,6,7];

  function reg8(s) {
    s = s.trim().toUpperCase();
    if (REG8[s] === undefined) throw `Invalid register: ${s}`;
    return REG8[s];
  }

  function reg16(s, table) {
    s = s.trim().toUpperCase();
    if (table[s] === undefined) throw `Invalid register pair: ${s}`;
    return table[s];
  }

  function imm8(s, symbols) {
    const v = resolveExpr(s.trim(), symbols);
    if (v < -128 || v > 255) throw `Byte value out of range: ${s}`;
    return v & 0xFF;
  }

  function imm16(s, symbols) {
    const v = resolveExpr(s.trim(), symbols);
    if (v < 0 || v > 65535) throw `Word value out of range: ${s}`;
    return [v & 0xFF, (v >> 8) & 0xFF];
  }

  // Resolve a numeric expression (number, label, simple arithmetic)
  function resolveExpr(expr, symbols) {
    if (!symbols) return 0; // pass 1 placeholder

    expr = expr.trim();

    // Hex: 0FFH, 0x0FF, $FF
    let m;
    if ((m = expr.match(/^([0-9A-Fa-f]+)[Hh]$/))) return parseInt(m[1], 16);
    if ((m = expr.match(/^0[Xx]([0-9A-Fa-f]+)$/))) return parseInt(m[1], 16);
    if ((m = expr.match(/^\$([0-9A-Fa-f]+)$/))) return parseInt(m[1], 16);

    // Octal: 077Q or 077O
    if ((m = expr.match(/^([0-7]+)[QqOo]$/))) return parseInt(m[1], 8);

    // Binary: 1010B
    if ((m = expr.match(/^([01]+)[Bb]$/))) return parseInt(m[1], 2);

    // Decimal
    if ((m = expr.match(/^-?[0-9]+$/))) return parseInt(expr, 10);

    // Char: 'A'
    if ((m = expr.match(/^'(.)'$/))) return m[1].charCodeAt(0);

    // Label or EQU symbol
    if ((m = expr.match(/^[A-Za-z_][A-Za-z0-9_.]*$/))) {
      const up = expr.toUpperCase();
      if (symbols[up] !== undefined) return symbols[up];
      throw `Undefined symbol: ${expr}`;
    }

    // Simple binary arithmetic (label+N, label-N, N+N, N-N)
    if ((m = expr.match(/^(.+?)\s*([+\-])\s*(.+)$/))) {
      const left = resolveExpr(m[1], symbols);
      const right = resolveExpr(m[3], symbols);
      return m[2] === '+' ? left + right : left - right;
    }

    throw `Cannot resolve expression: ${expr}`;
  }

  // Split operands respecting parentheses
  function splitOps(s) {
    if (!s || !s.trim()) return [];
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // ---- Directive handlers ----------------------------------

  const DIRECTIVES = new Set(['ORG','EQU','DB','DW','DS','END','SET','DEFB','DEFW','DEFS']);

  // ---- Mnemonic -> encoder ---------------------------------
  // Each returns array of byte values (numbers)

  const ENCODERS = {
    // Data transfer
    MOV(ops, sym) {
      const [d, s] = splitOps(ops);
      if (!d || !s) throw 'MOV requires two operands';
      const dr = reg8(d), sr = reg8(s);
      if (dr === 6 && sr === 6) throw 'MOV M,M is illegal';
      return [0x40 | (dr << 3) | sr];
    },
    MVI(ops, sym) {
      const [d, imm] = splitOps(ops);
      return [0x06 | (reg8(d) << 3), imm8(imm, sym)];
    },
    LXI(ops, sym) {
      const [rp, imm] = splitOps(ops);
      return [0x01 | (reg16(rp, REG16_BC_DE_HL_SP) << 4), ...imm16(imm, sym)];
    },
    LDA(ops, sym)  { return [0x3A, ...imm16(ops, sym)]; },
    STA(ops, sym)  { return [0x32, ...imm16(ops, sym)]; },
    LHLD(ops, sym) { return [0x2A, ...imm16(ops, sym)]; },
    SHLD(ops, sym) { return [0x22, ...imm16(ops, sym)]; },
    LDAX(ops, sym) {
      const rp = ops.trim().toUpperCase();
      if (rp !== 'BC' && rp !== 'DE') throw 'LDAX: BC or DE only';
      return [rp === 'BC' ? 0x0A : 0x1A];
    },
    STAX(ops, sym) {
      const rp = ops.trim().toUpperCase();
      if (rp !== 'BC' && rp !== 'DE') throw 'STAX: BC or DE only';
      return [rp === 'BC' ? 0x02 : 0x12];
    },
    XCHG() { return [0xEB]; },
    // Arithmetic
    ADD(ops, sym)  { return [0x80 | reg8(ops)]; },
    ADI(ops, sym)  { return [0xC6, imm8(ops, sym)]; },
    ADC(ops, sym)  { return [0x88 | reg8(ops)]; },
    ACI(ops, sym)  { return [0xCE, imm8(ops, sym)]; },
    SUB(ops, sym)  { return [0x90 | reg8(ops)]; },
    SUI(ops, sym)  { return [0xD6, imm8(ops, sym)]; },
    SBB(ops, sym)  { return [0x98 | reg8(ops)]; },
    SBI(ops, sym)  { return [0xDE, imm8(ops, sym)]; },
    INR(ops, sym)  { return [0x04 | (reg8(ops) << 3)]; },
    DCR(ops, sym)  { return [0x05 | (reg8(ops) << 3)]; },
    INX(ops, sym)  { return [0x03 | (reg16(ops, REG16_BC_DE_HL_SP) << 4)]; },
    DCX(ops, sym)  { return [0x0B | (reg16(ops, REG16_BC_DE_HL_SP) << 4)]; },
    DAD(ops, sym)  { return [0x09 | (reg16(ops, REG16_BC_DE_HL_SP) << 4)]; },
    DAA()          { return [0x27]; },
    // Logical
    ANA(ops, sym)  { return [0xA0 | reg8(ops)]; },
    ANI(ops, sym)  { return [0xE6, imm8(ops, sym)]; },
    ORA(ops, sym)  { return [0xB0 | reg8(ops)]; },
    ORI(ops, sym)  { return [0xF6, imm8(ops, sym)]; },
    XRA(ops, sym)  { return [0xA8 | reg8(ops)]; },
    XRI(ops, sym)  { return [0xEE, imm8(ops, sym)]; },
    CMP(ops, sym)  { return [0xB8 | reg8(ops)]; },
    CPI(ops, sym)  { return [0xFE, imm8(ops, sym)]; },
    RLC()          { return [0x07]; },
    RRC()          { return [0x0F]; },
    RAL()          { return [0x17]; },
    RAR()          { return [0x1F]; },
    CMA()          { return [0x2F]; },
    CMC()          { return [0x3F]; },
    STC()          { return [0x37]; },
    // Branch
    JMP(ops, sym)  { return [0xC3, ...imm16(ops, sym)]; },
    JNZ(ops, sym)  { return [0xC2, ...imm16(ops, sym)]; },
    JZ(ops, sym)   { return [0xCA, ...imm16(ops, sym)]; },
    JNC(ops, sym)  { return [0xD2, ...imm16(ops, sym)]; },
    JC(ops, sym)   { return [0xDA, ...imm16(ops, sym)]; },
    JPO(ops, sym)  { return [0xE2, ...imm16(ops, sym)]; },
    JPE(ops, sym)  { return [0xEA, ...imm16(ops, sym)]; },
    JP(ops, sym)   { return [0xF2, ...imm16(ops, sym)]; },
    JM(ops, sym)   { return [0xFA, ...imm16(ops, sym)]; },
    CALL(ops, sym) { return [0xCD, ...imm16(ops, sym)]; },
    CNZ(ops, sym)  { return [0xC4, ...imm16(ops, sym)]; },
    CZ(ops, sym)   { return [0xCC, ...imm16(ops, sym)]; },
    CNC(ops, sym)  { return [0xD4, ...imm16(ops, sym)]; },
    CC(ops, sym)   { return [0xDC, ...imm16(ops, sym)]; },
    CPO(ops, sym)  { return [0xE4, ...imm16(ops, sym)]; },
    CPE(ops, sym)  { return [0xEC, ...imm16(ops, sym)]; },
    CP(ops, sym)   { return [0xF4, ...imm16(ops, sym)]; },
    CM(ops, sym)   { return [0xFC, ...imm16(ops, sym)]; },
    RET()          { return [0xC9]; },
    RNZ()          { return [0xC0]; },
    RZ()           { return [0xC8]; },
    RNC()          { return [0xD0]; },
    RC()           { return [0xD8]; },
    RPO()          { return [0xE0]; },
    RPE()          { return [0xE8]; },
    RP()           { return [0xF0]; },
    RM()           { return [0xF8]; },
    PCHL()         { return [0xE9]; },
    RST(ops, sym)  {
      const n = resolveExpr(ops, sym);
      if (n < 0 || n > 7) throw `RST n must be 0-7`;
      return [0xC7 | (n << 3)];
    },
    // Stack
    PUSH(ops, sym) { return [0xC5 | (reg16(ops, REG16_BC_DE_HL_PSW) << 4)]; },
    POP(ops, sym)  { return [0xC1 | (reg16(ops, REG16_BC_DE_HL_PSW) << 4)]; },
    XTHL()         { return [0xE3]; },
    SPHL()         { return [0xF9]; },
    // I/O
    IN(ops, sym)   { return [0xDB, imm8(ops, sym)]; },
    OUT(ops, sym)  { return [0xD3, imm8(ops, sym)]; },
    // Control
    EI()           { return [0xFB]; },
    DI()           { return [0xF3]; },
    HLT()          { return [0x76]; },
    NOP()          { return [0x00]; },
    // 8085 specific
    RIM()          { return [0x20]; },
    SIM()          { return [0x30]; },
  };

  // ---- Parser ----------------------------------------------

  function parseLine(line) {
    // Remove comments
    const commentIdx = line.indexOf(';');
    if (commentIdx !== -1) line = line.substring(0, commentIdx);
    line = line.trim();
    if (!line) return null;

    // Label detection: starts at col 0 or ends with ':'
    let label = null, rest = line;

    // Label at start (no leading whitespace in original)
    const colonIdx = line.search(/\s|:/);
    if (colonIdx === 0) {
      // starts with whitespace - no label
    } else {
      const firstToken = line.split(/[\s:]/)[0];
      if (line.startsWith(firstToken) && (line[firstToken.length] === ':' || !line[firstToken.length] || /\s/.test(line[firstToken.length]))) {
        // Check if firstToken is a mnemonic or directive
        const up = firstToken.toUpperCase();
        if (!ENCODERS[up] && !DIRECTIVES.has(up)) {
          label = firstToken.toUpperCase();
          rest = line.substring(firstToken.length).replace(/^:?\s*/, '');
        }
      }
    }

    if (!rest.trim()) return { label, mnemonic: null, operands: '' };

    // Mnemonic + operands
    const parts = rest.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/);
    if (!parts) return { label, mnemonic: null, operands: '' };

    return {
      label,
      mnemonic: parts[1].toUpperCase(),
      operands: (parts[2] || '').trim(),
    };
  }

  // ---- Two-pass assembly -----------------------------------

  function assemble(source) {
    const lines = source.split('\n');
    const errors = [];
    const symbols = {};
    let origin = 0;
    let pc = 0;

    // Map from address -> source line number (0-indexed)
    const addrToLine = {};
    // Instruction list for pass 2
    const instructions = []; // { lineNum, pc, parsed, size }

    // ---- PASS 1: collect labels & compute sizes ----
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const parsed = parseLine(raw);
      if (!parsed) { instructions.push(null); continue; }

      // Handle label
      if (parsed.label) {
        if (symbols[parsed.label] !== undefined) {
          errors.push({ line: i + 1, msg: `Duplicate label: ${parsed.label}` });
        }
        symbols[parsed.label] = pc;
      }

      if (!parsed.mnemonic) { instructions.push(null); continue; }

      const mn = parsed.mnemonic;

      // Directives
      if (mn === 'ORG') {
        try {
          pc = resolveExpr(parsed.operands, symbols);
          origin = pc;
        } catch(e) {
          errors.push({ line: i+1, msg: String(e) });
        }
        instructions.push({ lineNum: i, pc, parsed, size: 0, isDirective: true });
        continue;
      }
      if (mn === 'EQU' || mn === 'SET') {
        try {
          const val = resolveExpr(parsed.operands, symbols);
          if (parsed.label) symbols[parsed.label] = val;
        } catch(e) { /* defer to pass 2 */ }
        instructions.push({ lineNum: i, pc, parsed, size: 0, isDirective: true });
        continue;
      }
      if (mn === 'END') {
        instructions.push({ lineNum: i, pc, parsed, size: 0, isDirective: true });
        break;
      }
      if (mn === 'DB' || mn === 'DEFB') {
        const size = estimateDB(parsed.operands);
        instructions.push({ lineNum: i, pc, parsed, size, isDirective: true });
        pc += size;
        continue;
      }
      if (mn === 'DW' || mn === 'DEFW') {
        const count = parsed.operands.split(',').length;
        const size = count * 2;
        instructions.push({ lineNum: i, pc, parsed, size, isDirective: true });
        pc += size;
        continue;
      }
      if (mn === 'DS' || mn === 'DEFS') {
        let size = 0;
        try { size = resolveExpr(parsed.operands, symbols); } catch(e) {}
        instructions.push({ lineNum: i, pc, parsed, size, isDirective: true });
        pc += size;
        continue;
      }

      // Regular instruction
      const encoder = ENCODERS[mn];
      if (!encoder) {
        errors.push({ line: i+1, msg: `Unknown mnemonic: ${mn}` });
        instructions.push(null);
        continue;
      }

      // Estimate size by trying to encode with dummy symbols
      let size = 1;
      try {
        const dummy = new Proxy(symbols, {
          get(t, k) { return t[k] !== undefined ? t[k] : 0; }
        });
        const bytes = encoder(parsed.operands, dummy);
        size = bytes.length;
      } catch(e) { size = guessSize(mn); }

      addrToLine[pc] = i;
      instructions.push({ lineNum: i, pc, parsed, size });
      pc += size;
    }

    if (errors.length > 0) return { success: false, errors, bytes: null, symbols, addrToLine, origin };

    // ---- PASS 2: generate bytes ----
    const maxAddr = 65536;
    const memory = new Uint8Array(maxAddr);
    const pass2Errors = [];
    const lineToAddr = {};

    for (const inst of instructions) {
      if (!inst) continue;
      const { lineNum, pc: addr, parsed } = inst;
      if (!parsed.mnemonic) continue;

      const mn = parsed.mnemonic;
      lineToAddr[lineNum] = addr;

      if (mn === 'ORG') {
        // already handled
        continue;
      }
      if (mn === 'EQU' || mn === 'SET') {
        try {
          const val = resolveExpr(parsed.operands, symbols);
          if (parsed.label) symbols[parsed.label] = val;
        } catch(e) {
          pass2Errors.push({ line: lineNum+1, msg: String(e) });
        }
        continue;
      }
      if (mn === 'END') break;

      if (mn === 'DB' || mn === 'DEFB') {
        const bytes = encodeDB(parsed.operands, symbols, lineNum+1, pass2Errors);
        bytes.forEach((b, i) => { if (addr+i < maxAddr) memory[addr+i] = b; });
        addrToLine[addr] = lineNum;
        continue;
      }
      if (mn === 'DW' || mn === 'DEFW') {
        const items = parsed.operands.split(',');
        let off = 0;
        for (const item of items) {
          try {
            const v = resolveExpr(item.trim(), symbols);
            memory[addr+off] = v & 0xFF;
            memory[addr+off+1] = (v >> 8) & 0xFF;
            off += 2;
          } catch(e) { pass2Errors.push({ line: lineNum+1, msg: String(e) }); }
        }
        addrToLine[addr] = lineNum;
        continue;
      }
      if (mn === 'DS' || mn === 'DEFS') {
        // zero fill
        addrToLine[addr] = lineNum;
        continue;
      }

      const encoder = ENCODERS[mn];
      if (!encoder) continue;

      try {
        const bytes = encoder(parsed.operands, symbols);
        bytes.forEach((b, i) => {
          if (addr+i < maxAddr) memory[addr+i] = b & 0xFF;
        });
        addrToLine[addr] = lineNum;
      } catch(e) {
        pass2Errors.push({ line: lineNum+1, msg: String(e) });
      }
    }

    const allErrors = [...errors, ...pass2Errors];
    if (allErrors.length > 0) return { success: false, errors: allErrors, bytes: null, symbols, addrToLine, origin };

    return { success: true, errors: [], bytes: memory, symbols, addrToLine, lineToAddr, origin };
  }

  function estimateDB(operands) {
    // rough estimate
    let count = 0;
    for (const part of operands.split(',')) {
      const t = part.trim();
      if (t.startsWith("'") || t.startsWith('"')) {
        count += t.length - 2;
      } else {
        count += 1;
      }
    }
    return Math.max(1, count);
  }

  function encodeDB(operands, symbols, lineNum, errors) {
    const bytes = [];
    // Split by comma but respect strings
    const parts = [];
    let cur = '', inStr = false, strChar = '';
    for (let i = 0; i < operands.length; i++) {
      const ch = operands[i];
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; cur += ch; }
      else if (inStr && ch === strChar) { inStr = false; cur += ch; }
      else if (!inStr && ch === ',') { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    for (const part of parts) {
      const t = part.trim();
      if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
        const str = t.slice(1, -1);
        for (const ch of str) bytes.push(ch.charCodeAt(0) & 0xFF);
      } else {
        try { bytes.push(resolveExpr(t, symbols) & 0xFF); }
        catch(e) { errors.push({ line: lineNum, msg: String(e) }); bytes.push(0); }
      }
    }
    return bytes;
  }

  function guessSize(mn) {
    const three = ['LXI','LDA','STA','LHLD','SHLD','JMP','JNZ','JZ','JNC','JC','JPO','JPE','JP','JM','CALL','CNZ','CZ','CNC','CC','CPO','CPE','CP','CM'];
    const two   = ['MVI','ADI','ACI','SUI','SBI','ANI','ORI','XRI','CPI','IN','OUT','RST'];
    if (three.includes(mn)) return 3;
    if (two.includes(mn)) return 2;
    return 1;
  }

  return { assemble };
})();
