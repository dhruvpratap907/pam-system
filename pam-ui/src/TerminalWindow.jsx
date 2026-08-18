import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export default function TerminalWindow({ targetHost, grantId, onDisconnect }) {
  const terminalRef = useRef(null);
  const xtermInstance = useRef(null);
  const wsRef = useRef(null); 

  useEffect(() => {
    // 1. Initialize the xterm.js instance
    const term = new Terminal({
      cursorBlink: true,
      theme: { background: '#1e1e1e', foreground: '#00ff00' },
      fontFamily: '"Fira Code", monospace',
    });
    xtermInstance.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    if (terminalRef.current) {
      term.open(terminalRef.current);
      fitAddon.fit();
    }

    term.writeln(`\x1b[1;34m[System]\x1b[0m Connecting to Zero Trust Gateway for: ${targetHost}...`);

    // 2. Open the Two-Way WebSocket Connection (NOW WITH THE REAL ID!)
    const ws = new WebSocket(`ws://127.0.0.1:8443/ws?target=${targetHost}&grant_id=${grantId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln(`\x1b[1;32m[Success]\x1b[0m Gateway reached! Negotiating SSH connection...`);
    };

    // 3. Listen for text coming FROM the server and print it
    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = () => {
      term.writeln(`\r\n\x1b[1;31m[Disconnected]\x1b[0m Connection closed by server.`);
    };

    ws.onerror = () => {
      term.writeln(`\r\n\x1b[1;31m[Error]\x1b[0m Could not connect to the Rust Gateway WebSocket.`);
    };

    // 4. Capture your Keystrokes and send them TO the server
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, [targetHost, grantId]);

  return (
    <div style={{ marginTop: '20px', border: '1px solid #333', borderRadius: '8px', overflow: 'hidden' }}>
      <div style={{ background: '#2d2d2d', padding: '8px 15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#fff', fontSize: '14px', fontFamily: 'monospace' }}>
          Session Active: {targetHost} | Audit ID: {grantId}
        </span>
        <button onClick={onDisconnect} style={{ background: '#ff4646', color: 'white', padding: '4px 10px', fontSize: '12px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          End Session
        </button>
      </div>
      <div ref={terminalRef} style={{ height: '400px', width: '100%', padding: '10px', background: '#1e1e1e' }} />
    </div>
  );
}