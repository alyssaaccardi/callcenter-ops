import React from 'react';
import './DialingIn.css';

const UFO =
`    .--------.
   / o  o  o  \\
  (  --------  )
   '--[====]--'`;

const VICTIM =
`    \\o/
     |
    / \\`;

export function DialingIn({ text = 'DIALING IN' }) {
  return (
    <div className="di-wrap">
      <div className="di-scene">
        <div className="di-ufo-group">
          <pre className="di-ufo">{UFO}</pre>
          <div className="di-beam" />
        </div>
        <pre className="di-victim">{VICTIM}</pre>
      </div>
      <div className="di-label">{text}<span className="di-cursor">_</span></div>
    </div>
  );
}
