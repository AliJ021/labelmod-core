import {useId,useState} from "react";
import type {ReactNode} from "react";

/** A click pins the hint for touch. Hovering the text itself keeps it readable. */
export function HelpHint({label,children,descriptionId}:{label:string;children:ReactNode;descriptionId?:string}) {
  const generated=useId();
  const id=descriptionId ?? generated;
  const [open,setOpen]=useState(false);
  return <span className="help-hint" onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>setOpen(false)}
    onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}}
    onKeyDown={e=>{if(e.key==="Escape"){setOpen(false);e.stopPropagation();}}}>
    <button type="button" className="help-hint-trigger" aria-label={"راهنمای "+label} aria-expanded={open} aria-controls={id}
      aria-describedby={open?id:undefined} onFocus={()=>setOpen(true)} onClick={()=>setOpen(true)}>؟</button>
    <span role="tooltip" id={id} hidden={!open} className="help-hint-text">{children}</span>
  </span>;
}
