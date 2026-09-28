import { Component, type ReactNode } from "react";

/** خطای بارگذاری یک بخش نباید ناوبری و ابزارهای حساب را از دسترس خارج کند. */
export class SectionBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  override state={failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  override render() {
    if(this.state.failed) return <section className="solid pad stack" role="alert">
      <h1>این بخش کامل بارگذاری نشد</h1>
      <p>اتصال را بررسی و صفحه را دوباره بارگذاری کنید. عملیات نامشخص را پیش از ثبت دوباره، از فاکتورها بررسی کنید.</p>
      <button className="btn" type="button" onClick={()=>window.location.reload()}>بارگذاری دوبارهٔ صفحه</button>
    </section>;
    return this.props.children;
  }
}
