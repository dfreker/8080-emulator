// ============================================================
// Intel 8080/8085 CPU Emulator
// ============================================================

'use strict';

const Emulator = (() => {

  // CPU State
  let mem = new Uint8Array(65536);
  let A=0, B=0, C=0, D=0, E=0, H=0, L=0;
  let SP=0, PC=0;
  let flagS=0, flagZ=0, flagAC=0, flagP=0, flagCY=0;
  let halted = false;
  let cycles = 0;
  let ioOutput = null;  // callback(port, value)
  let ioInput  = null;  // callback(port) -> value
  let haltCallback = null;
  let errorCallback = null;

  // ---- Helpers ----

  function getFlags() {
    return (flagS<<7)|(flagZ<<6)|(flagAC<<4)|(flagP<<2)|0x02|(flagCY);
  }

  function setFlags(f) {
    flagS  = (f >> 7) & 1;
    flagZ  = (f >> 6) & 1;
    flagAC = (f >> 4) & 1;
    flagP  = (f >> 2) & 1;
    flagCY = f & 1;
  }

  function parity(v) {
    v &= 0xFF;
    v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
    return (~v) & 1;
  }

  function setArithFlags(result, ac) {
    const r = result & 0xFF;
    flagZ  = r === 0 ? 1 : 0;
    flagS  = (r >> 7) & 1;
    flagP  = parity(r);
    flagCY = (result > 0xFF || result < 0) ? 1 : 0;
    if (ac !== undefined) flagAC = ac;
  }

  function getHL() { return (H << 8) | L; }
  function getBC() { return (B << 8) | C; }
  function getDE() { return (D << 8) | E; }

  function readReg(r) {
    switch(r) {
      case 0: return B; case 1: return C; case 2: return D;
      case 3: return E; case 4: return H; case 5: return L;
      case 6: return mem[getHL()]; case 7: return A;
    }
  }

  function writeReg(r, v) {
    v &= 0xFF;
    switch(r) {
      case 0: B=v; break; case 1: C=v; break;
      case 2: D=v; break; case 3: E=v; break;
      case 4: H=v; break; case 5: L=v; break;
      case 6: mem[getHL()] = v; break;
      case 7: A=v; break;
    }
  }

  function fetch8() { const v = mem[PC]; PC = (PC+1) & 0xFFFF; return v; }
  function fetch16() { const lo = fetch8(), hi = fetch8(); return (hi<<8)|lo; }

  function push16(v) {
    SP = (SP-1) & 0xFFFF; mem[SP] = (v>>8) & 0xFF;
    SP = (SP-1) & 0xFFFF; mem[SP] = v & 0xFF;
  }

  function pop16() {
    const lo = mem[SP]; SP = (SP+1) & 0xFFFF;
    const hi = mem[SP]; SP = (SP+1) & 0xFFFF;
    return (hi<<8)|lo;
  }

  // ---- ADD with carry-out and AC ----
  function doADD(a, b, carry) {
    carry = carry || 0;
    const ac = ((a & 0xF) + (b & 0xF) + carry) > 0xF ? 1 : 0;
    const result = a + b + carry;
    setArithFlags(result, ac);
    return result & 0xFF;
  }

  function doSUB(a, b, borrow) {
    borrow = borrow || 0;
    const ac = ((a & 0xF) - (b & 0xF) - borrow) < 0 ? 1 : 0;
    const result = a - b - borrow;
    setArithFlags(result, ac);
    flagCY = result < 0 ? 1 : 0;
    return result & 0xFF;
  }

  // ---- Cycle counts (approximate) ----
  const CYCLES = new Uint8Array(256);
  (function() {
    // Fill with reasonable defaults
    for (let i=0; i<256; i++) CYCLES[i] = 4;
    // MOV r,r (5 for M involved, 7)
    for (let d=0; d<8; d++) for (let s=0; s<8; s++) {
      CYCLES[0x40|(d<<3)|s] = (d===6||s===6) ? 7 : 5;
    }
    CYCLES[0x76] = 7; // HLT
    // MVI
    for (let r=0; r<8; r++) CYCLES[0x06|(r<<3)] = (r===6) ? 10 : 7;
    // LXI / INX / DCX / DAD
    for (let r=0; r<4; r++) {
      CYCLES[0x01|(r<<4)] = 10;
      CYCLES[0x03|(r<<4)] = 5;
      CYCLES[0x0B|(r<<4)] = 5;
      CYCLES[0x09|(r<<4)] = 10;
    }
    CYCLES[0x3A]=13; CYCLES[0x32]=13; CYCLES[0x2A]=16; CYCLES[0x22]=16;
    CYCLES[0x0A]=7;  CYCLES[0x1A]=7;  CYCLES[0x02]=7;  CYCLES[0x12]=7;
    CYCLES[0xEB]=4;
    // ADD/ADC/SUB/SBB/ANA/ORA/XRA/CMP
    for (let r=0; r<8; r++) {
      const m = (r===6);
      CYCLES[0x80|r]=m?7:4; CYCLES[0x88|r]=m?7:4;
      CYCLES[0x90|r]=m?7:4; CYCLES[0x98|r]=m?7:4;
      CYCLES[0xA0|r]=m?7:4; CYCLES[0xA8|r]=m?7:4;
      CYCLES[0xB0|r]=m?7:4; CYCLES[0xB8|r]=m?7:4;
    }
    CYCLES[0xC6]=7; CYCLES[0xCE]=7; CYCLES[0xD6]=7; CYCLES[0xDE]=7;
    CYCLES[0xE6]=7; CYCLES[0xEE]=7; CYCLES[0xF6]=7; CYCLES[0xFE]=7;
    // INR/DCR
    for (let r=0; r<8; r++) {
      CYCLES[0x04|(r<<3)] = (r===6) ? 10 : 5;
      CYCLES[0x05|(r<<3)] = (r===6) ? 10 : 5;
    }
    CYCLES[0x27]=4; CYCLES[0x2F]=4; CYCLES[0x3F]=4; CYCLES[0x37]=4;
    CYCLES[0x07]=4; CYCLES[0x0F]=4; CYCLES[0x17]=4; CYCLES[0x1F]=4;
    // Jumps / calls / rets
    [0xC3,0xC2,0xCA,0xD2,0xDA,0xE2,0xEA,0xF2,0xFA].forEach(o=>CYCLES[o]=10);
    [0xCD,0xC4,0xCC,0xD4,0xDC,0xE4,0xEC,0xF4,0xFC].forEach(o=>CYCLES[o]=17);
    [0xC9,0xC0,0xC8,0xD0,0xD8,0xE0,0xE8,0xF0,0xF8].forEach(o=>CYCLES[o]=10);
    CYCLES[0xE9]=5;
    // Stack
    for (let r=0; r<4; r++) {
      CYCLES[0xC5|(r<<4)]=11; CYCLES[0xC1|(r<<4)]=10;
    }
    CYCLES[0xE3]=18; CYCLES[0xF9]=5;
    // I/O
    CYCLES[0xDB]=10; CYCLES[0xD3]=10;
    // Interrupts
    CYCLES[0xFB]=4; CYCLES[0xF3]=4;
    // RST
    for (let n=0; n<8; n++) CYCLES[0xC7|(n<<3)]=11;
    // 8085
    CYCLES[0x20]=4; CYCLES[0x30]=4;
  })();

  // ---- Execute one instruction ----
  function step() {
    if (halted) return false;

    const opcode = fetch8();
    cycles += CYCLES[opcode];

    switch(opcode) {
      case 0x00: break; // NOP
      case 0x76: // HLT
        halted = true;
        PC = (PC - 1) & 0xFFFF; // stay on HLT
        if (haltCallback) haltCallback();
        return false;

      // ---- MOV r,r ----
      case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
      case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F:
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
      case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F:
      case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67:
      case 0x68: case 0x69: case 0x6A: case 0x6B: case 0x6C: case 0x6D: case 0x6E: case 0x6F:
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75:             case 0x77:
      case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F:
        writeReg((opcode>>3)&7, readReg(opcode&7)); break;

      // ---- MVI ----
      case 0x06: B=fetch8(); break; case 0x0E: C=fetch8(); break;
      case 0x16: D=fetch8(); break; case 0x1E: E=fetch8(); break;
      case 0x26: H=fetch8(); break; case 0x2E: L=fetch8(); break;
      case 0x36: mem[getHL()]=fetch8(); break; case 0x3E: A=fetch8(); break;

      // ---- LXI ----
      case 0x01: { const v=fetch16(); B=(v>>8)&0xFF; C=v&0xFF; } break;
      case 0x11: { const v=fetch16(); D=(v>>8)&0xFF; E=v&0xFF; } break;
      case 0x21: { const v=fetch16(); H=(v>>8)&0xFF; L=v&0xFF; } break;
      case 0x31: SP=fetch16(); break;

      // ---- Load/Store direct ----
      case 0x3A: { const a=fetch16(); A=mem[a]; } break;
      case 0x32: { const a=fetch16(); mem[a]=A; } break;
      case 0x2A: { const a=fetch16(); L=mem[a]; H=mem[(a+1)&0xFFFF]; } break;
      case 0x22: { const a=fetch16(); mem[a]=L; mem[(a+1)&0xFFFF]=H; } break;
      case 0x0A: A=mem[getBC()]; break;
      case 0x1A: A=mem[getDE()]; break;
      case 0x02: mem[getBC()]=A; break;
      case 0x12: mem[getDE()]=A; break;
      case 0xEB: { const th=H,tl=L; H=D; L=E; D=th; E=tl; } break;

      // ---- ADD / ADC ----
      case 0x80: A=doADD(A,B,0); break; case 0x81: A=doADD(A,C,0); break;
      case 0x82: A=doADD(A,D,0); break; case 0x83: A=doADD(A,E,0); break;
      case 0x84: A=doADD(A,H,0); break; case 0x85: A=doADD(A,L,0); break;
      case 0x86: A=doADD(A,mem[getHL()],0); break; case 0x87: A=doADD(A,A,0); break;
      case 0x88: A=doADD(A,B,flagCY); break; case 0x89: A=doADD(A,C,flagCY); break;
      case 0x8A: A=doADD(A,D,flagCY); break; case 0x8B: A=doADD(A,E,flagCY); break;
      case 0x8C: A=doADD(A,H,flagCY); break; case 0x8D: A=doADD(A,L,flagCY); break;
      case 0x8E: A=doADD(A,mem[getHL()],flagCY); break; case 0x8F: A=doADD(A,A,flagCY); break;
      case 0xC6: A=doADD(A,fetch8(),0); break;
      case 0xCE: A=doADD(A,fetch8(),flagCY); break;

      // ---- SUB / SBB ----
      case 0x90: A=doSUB(A,B,0); break; case 0x91: A=doSUB(A,C,0); break;
      case 0x92: A=doSUB(A,D,0); break; case 0x93: A=doSUB(A,E,0); break;
      case 0x94: A=doSUB(A,H,0); break; case 0x95: A=doSUB(A,L,0); break;
      case 0x96: A=doSUB(A,mem[getHL()],0); break; case 0x97: A=doSUB(A,A,0); break;
      case 0x98: A=doSUB(A,B,flagCY); break; case 0x99: A=doSUB(A,C,flagCY); break;
      case 0x9A: A=doSUB(A,D,flagCY); break; case 0x9B: A=doSUB(A,E,flagCY); break;
      case 0x9C: A=doSUB(A,H,flagCY); break; case 0x9D: A=doSUB(A,L,flagCY); break;
      case 0x9E: A=doSUB(A,mem[getHL()],flagCY); break; case 0x9F: A=doSUB(A,A,flagCY); break;
      case 0xD6: A=doSUB(A,fetch8(),0); break;
      case 0xDE: A=doSUB(A,fetch8(),flagCY); break;

      // ---- INR / DCR ----
      case 0x04: { const r=B+1; const ac=((B&0xF)+1)>0xF?1:0; B=r&0xFF; setArithFlagsNoCarry(B,ac); } break;
      case 0x0C: { const r=C+1; const ac=((C&0xF)+1)>0xF?1:0; C=r&0xFF; setArithFlagsNoCarry(C,ac); } break;
      case 0x14: { const r=D+1; const ac=((D&0xF)+1)>0xF?1:0; D=r&0xFF; setArithFlagsNoCarry(D,ac); } break;
      case 0x1C: { const r=E+1; const ac=((E&0xF)+1)>0xF?1:0; E=r&0xFF; setArithFlagsNoCarry(E,ac); } break;
      case 0x24: { const r=H+1; const ac=((H&0xF)+1)>0xF?1:0; H=r&0xFF; setArithFlagsNoCarry(H,ac); } break;
      case 0x2C: { const r=L+1; const ac=((L&0xF)+1)>0xF?1:0; L=r&0xFF; setArithFlagsNoCarry(L,ac); } break;
      case 0x34: { const m=mem[getHL()]; const r=m+1; const ac=((m&0xF)+1)>0xF?1:0; mem[getHL()]=r&0xFF; setArithFlagsNoCarry(r&0xFF,ac); } break;
      case 0x3C: { const r=A+1; const ac=((A&0xF)+1)>0xF?1:0; A=r&0xFF; setArithFlagsNoCarry(A,ac); } break;
      case 0x05: { const r=B-1; const ac=((B&0xF)-1)<0?1:0; B=r&0xFF; setArithFlagsNoCarry(B,ac); } break;
      case 0x0D: { const r=C-1; const ac=((C&0xF)-1)<0?1:0; C=r&0xFF; setArithFlagsNoCarry(C,ac); } break;
      case 0x15: { const r=D-1; const ac=((D&0xF)-1)<0?1:0; D=r&0xFF; setArithFlagsNoCarry(D,ac); } break;
      case 0x1D: { const r=E-1; const ac=((E&0xF)-1)<0?1:0; E=r&0xFF; setArithFlagsNoCarry(E,ac); } break;
      case 0x25: { const r=H-1; const ac=((H&0xF)-1)<0?1:0; H=r&0xFF; setArithFlagsNoCarry(H,ac); } break;
      case 0x2D: { const r=L-1; const ac=((L&0xF)-1)<0?1:0; L=r&0xFF; setArithFlagsNoCarry(L,ac); } break;
      case 0x35: { const m=mem[getHL()]; const r=m-1; const ac=((m&0xF)-1)<0?1:0; mem[getHL()]=r&0xFF; setArithFlagsNoCarry(r&0xFF,ac); } break;
      case 0x3D: { const r=A-1; const ac=((A&0xF)-1)<0?1:0; A=r&0xFF; setArithFlagsNoCarry(A,ac); } break;

      // ---- INX / DCX ----
      case 0x03: { const v=(getBC()+1)&0xFFFF; B=v>>8; C=v&0xFF; } break;
      case 0x13: { const v=(getDE()+1)&0xFFFF; D=v>>8; E=v&0xFF; } break;
      case 0x23: { const v=(getHL()+1)&0xFFFF; H=v>>8; L=v&0xFF; } break;
      case 0x33: SP=(SP+1)&0xFFFF; break;
      case 0x0B: { const v=(getBC()-1)&0xFFFF; B=v>>8; C=v&0xFF; } break;
      case 0x1B: { const v=(getDE()-1)&0xFFFF; D=v>>8; E=v&0xFF; } break;
      case 0x2B: { const v=(getHL()-1)&0xFFFF; H=v>>8; L=v&0xFF; } break;
      case 0x3B: SP=(SP-1)&0xFFFF; break;

      // ---- DAD ----
      case 0x09: { const r=getHL()+getBC(); flagCY=r>0xFFFF?1:0; const v=r&0xFFFF; H=v>>8; L=v&0xFF; } break;
      case 0x19: { const r=getHL()+getDE(); flagCY=r>0xFFFF?1:0; const v=r&0xFFFF; H=v>>8; L=v&0xFF; } break;
      case 0x29: { const r=getHL()+getHL(); flagCY=r>0xFFFF?1:0; const v=r&0xFFFF; H=v>>8; L=v&0xFF; } break;
      case 0x39: { const r=getHL()+SP; flagCY=r>0xFFFF?1:0; const v=r&0xFFFF; H=v>>8; L=v&0xFF; } break;

      // ---- DAA ----
      case 0x27: {
        let a = A, cy = flagCY, ac = flagAC;
        let correction = 0;
        if (ac || (a & 0xF) > 9) correction |= 0x06;
        if (cy || a > 0x99) { correction |= 0x60; cy = 1; }
        a = (a + correction) & 0xFF;
        flagZ = a===0?1:0; flagS=(a>>7)&1; flagP=parity(a); flagCY=cy;
        flagAC = ((A&0xF)+(correction&0xF)) > 0xF ? 1 : 0;
        A = a;
      } break;

      // ---- ANA / ORA / XRA / CMP ----
      case 0xA0: A=doLogic(A&B); break; case 0xA1: A=doLogic(A&C); break;
      case 0xA2: A=doLogic(A&D); break; case 0xA3: A=doLogic(A&E); break;
      case 0xA4: A=doLogic(A&H); break; case 0xA5: A=doLogic(A&L); break;
      case 0xA6: A=doLogic(A&mem[getHL()]); break; case 0xA7: A=doLogic(A&A); break;
      case 0xA8: A=doLogic(A^B); break; case 0xA9: A=doLogic(A^C); break;
      case 0xAA: A=doLogic(A^D); break; case 0xAB: A=doLogic(A^E); break;
      case 0xAC: A=doLogic(A^H); break; case 0xAD: A=doLogic(A^L); break;
      case 0xAE: A=doLogic(A^mem[getHL()]); break; case 0xAF: A=doLogic(A^A); break;
      case 0xB0: A=doLogic(A|B); break; case 0xB1: A=doLogic(A|C); break;
      case 0xB2: A=doLogic(A|D); break; case 0xB3: A=doLogic(A|E); break;
      case 0xB4: A=doLogic(A|H); break; case 0xB5: A=doLogic(A|L); break;
      case 0xB6: A=doLogic(A|mem[getHL()]); break; case 0xB7: A=doLogic(A|A); break;
      case 0xB8: doCMP(B); break; case 0xB9: doCMP(C); break;
      case 0xBA: doCMP(D); break; case 0xBB: doCMP(E); break;
      case 0xBC: doCMP(H); break; case 0xBD: doCMP(L); break;
      case 0xBE: doCMP(mem[getHL()]); break; case 0xBF: doCMP(A); break;
      case 0xE6: A=doLogic(A&fetch8()); break;
      case 0xEE: A=doLogic(A^fetch8()); break;
      case 0xF6: A=doLogic(A|fetch8()); break;
      case 0xFE: doCMP(fetch8()); break;

      // ---- Rotate ----
      case 0x07: { const b7=(A>>7)&1; A=((A<<1)|b7)&0xFF; flagCY=b7; } break;
      case 0x0F: { const b0=A&1; A=((A>>1)|(b0<<7))&0xFF; flagCY=b0; } break;
      case 0x17: { const b7=(A>>7)&1; A=((A<<1)|flagCY)&0xFF; flagCY=b7; } break;
      case 0x1F: { const b0=A&1; A=((A>>1)|(flagCY<<7))&0xFF; flagCY=b0; } break;
      case 0x2F: A=(~A)&0xFF; break;
      case 0x3F: flagCY=flagCY?0:1; break;
      case 0x37: flagCY=1; break;

      // ---- Jumps ----
      case 0xC3: PC=fetch16(); break;
      case 0xC2: { const a=fetch16(); if(!flagZ) PC=a; } break;
      case 0xCA: { const a=fetch16(); if(flagZ) PC=a; } break;
      case 0xD2: { const a=fetch16(); if(!flagCY) PC=a; } break;
      case 0xDA: { const a=fetch16(); if(flagCY) PC=a; } break;
      case 0xE2: { const a=fetch16(); if(!flagP) PC=a; } break;
      case 0xEA: { const a=fetch16(); if(flagP) PC=a; } break;
      case 0xF2: { const a=fetch16(); if(!flagS) PC=a; } break;
      case 0xFA: { const a=fetch16(); if(flagS) PC=a; } break;
      case 0xE9: PC=getHL(); break;

      // ---- Calls ----
      case 0xCD: { const a=fetch16(); push16(PC); PC=a; } break;
      case 0xC4: { const a=fetch16(); if(!flagZ){push16(PC);PC=a;} } break;
      case 0xCC: { const a=fetch16(); if(flagZ){push16(PC);PC=a;} } break;
      case 0xD4: { const a=fetch16(); if(!flagCY){push16(PC);PC=a;} } break;
      case 0xDC: { const a=fetch16(); if(flagCY){push16(PC);PC=a;} } break;
      case 0xE4: { const a=fetch16(); if(!flagP){push16(PC);PC=a;} } break;
      case 0xEC: { const a=fetch16(); if(flagP){push16(PC);PC=a;} } break;
      case 0xF4: { const a=fetch16(); if(!flagS){push16(PC);PC=a;} } break;
      case 0xFC: { const a=fetch16(); if(flagS){push16(PC);PC=a;} } break;

      // ---- Returns ----
      case 0xC9: PC=pop16(); break;
      case 0xC0: if(!flagZ) PC=pop16(); break;
      case 0xC8: if(flagZ)  PC=pop16(); break;
      case 0xD0: if(!flagCY)PC=pop16(); break;
      case 0xD8: if(flagCY) PC=pop16(); break;
      case 0xE0: if(!flagP) PC=pop16(); break;
      case 0xE8: if(flagP)  PC=pop16(); break;
      case 0xF0: if(!flagS) PC=pop16(); break;
      case 0xF8: if(flagS)  PC=pop16(); break;

      // ---- RST ----
      case 0xC7: push16(PC); PC=0x00; break; case 0xCF: push16(PC); PC=0x08; break;
      case 0xD7: push16(PC); PC=0x10; break; case 0xDF: push16(PC); PC=0x18; break;
      case 0xE7: push16(PC); PC=0x20; break; case 0xEF: push16(PC); PC=0x28; break;
      case 0xF7: push16(PC); PC=0x30; break; case 0xFF: push16(PC); PC=0x38; break;

      // ---- Stack ----
      case 0xC5: push16((B<<8)|C); break;
      case 0xD5: push16((D<<8)|E); break;
      case 0xE5: push16(getHL()); break;
      case 0xF5: push16((A<<8)|getFlags()); break;
      case 0xC1: { const v=pop16(); B=(v>>8)&0xFF; C=v&0xFF; } break;
      case 0xD1: { const v=pop16(); D=(v>>8)&0xFF; E=v&0xFF; } break;
      case 0xE1: { const v=pop16(); H=(v>>8)&0xFF; L=v&0xFF; } break;
      case 0xF1: { const v=pop16(); A=(v>>8)&0xFF; setFlags(v&0xFF); } break;
      case 0xE3: { const lo=mem[SP],hi=mem[(SP+1)&0xFFFF]; mem[SP]=L; mem[(SP+1)&0xFFFF]=H; L=lo; H=hi; } break;
      case 0xF9: SP=getHL(); break;

      // ---- I/O ----
      case 0xDB: { const port=fetch8(); A = ioInput ? (ioInput(port)&0xFF) : 0; } break;
      case 0xD3: { const port=fetch8(); if(ioOutput) ioOutput(port,A); } break;

      // ---- Interrupts ----
      case 0xFB: break; // EI — simplified (no interrupt emulation)
      case 0xF3: break; // DI

      // ---- 8085 ----
      case 0x20: A = 0; break; // RIM - simplified
      case 0x30: break;         // SIM - simplified

      default:
        if (errorCallback) errorCallback(`Unknown opcode 0x${opcode.toString(16).toUpperCase().padStart(2,'0')} at PC=0x${((PC-1)&0xFFFF).toString(16).toUpperCase().padStart(4,'0')}`);
        halted = true;
        return false;
    }

    return true;
  }

  function setArithFlagsNoCarry(v, ac) {
    flagZ = v===0?1:0;
    flagS = (v>>7)&1;
    flagP = parity(v);
    if (ac !== undefined) flagAC = ac;
  }

  function doLogic(v) {
    v &= 0xFF;
    flagZ=v===0?1:0; flagS=(v>>7)&1; flagP=parity(v); flagCY=0; flagAC=0;
    return v;
  }

  function doCMP(b) {
    doSUB(A, b, 0); // don't store result
  }

  // ---- Public API ----

  function reset() {
    A=B=C=D=E=H=L=0;
    SP=0; PC=0;
    flagS=flagZ=flagAC=flagP=flagCY=0;
    halted=false; cycles=0;
    mem.fill(0);
  }

  function loadProgram(bytes, origin) {
    reset();
    mem.fill(0);
    if (bytes) mem.set(bytes);
    PC = origin || 0;
  }

  function getState() {
    return {
      A, B, C, D, E, H, L, SP, PC,
      flagS, flagZ, flagAC, flagP, flagCY,
      halted, cycles,
      mem
    };
  }

  function setCallbacks(opts) {
    ioOutput = opts.ioOutput || null;
    ioInput  = opts.ioInput  || null;
    haltCallback  = opts.onHalt  || null;
    errorCallback = opts.onError || null;
  }

  return { reset, loadProgram, step, getState, setCallbacks };
})();
