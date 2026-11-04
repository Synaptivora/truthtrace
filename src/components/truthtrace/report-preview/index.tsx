"use client";
import {useEffect,useId,useRef} from "react";
import {Download,FileText,X} from "lucide-react";
import styles from "./report-preview.module.css";
type Props={html:string;onClose:()=>void;onDownload:()=>void;formatLabel?:string};
export function ReportPreview({html,onClose,onDownload,formatLabel="报告"}:Props){
 const dialog=useRef<HTMLDialogElement>(null);const closeButton=useRef<HTMLButtonElement>(null);const title=useId();const description=useId();const close=useRef(onClose);
 useEffect(()=>{close.current=onClose;},[onClose]);
 useEffect(()=>{const element=dialog.current;const previous=document.activeElement;if(!element)return;element.showModal();closeButton.current?.focus();return()=>{element.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 return <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} aria-describedby={description} onCancel={event=>{event.preventDefault();close.current();}} onClick={event=>{if(event.target===event.currentTarget){const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close.current();}}}><div className={styles.shell}><header className={styles.header}><div className={styles.title}><FileText size={20} aria-hidden="true"/><div><h2 id={title}>报告预览</h2><p>核对来源、版本与未覆盖范围后再导出</p></div></div><button ref={closeButton} type="button" className={styles.close} onClick={onClose} aria-label="关闭报告预览"><X size={20}/></button></header><div className={styles.toolbar}><p id={description}>预览保留材料陈述与核查边界；引用存在不代表事实已经证实。</p><button type="button" className={styles.download} disabled={!html.trim()} onClick={onDownload}><Download size={16} aria-hidden="true"/>导出{formatLabel}</button></div>{html.trim()?<iframe title="报告内容" sandbox="" srcDoc={html} className={styles.frame}/>:<div className={styles.empty} role="status"><FileText size={30} aria-hidden="true"/><strong>报告内容暂不可用</strong><p>关闭预览后重试；已保存的案件材料不会改变。</p></div>}<footer className={styles.footer}><span>需要打印或 PDF？导出 HTML 后，在浏览器中打开并选择“打印”。</span><span>Esc 关闭 · Tab 切换操作</span></footer></div></dialog>;
}
