export function Pairing({ invalid }: { invalid?: boolean }) {
  return (
    <div className="pairing">
      <div className="pairing-card">
        <div className="logo">K</div>
        <h1>kimi-remote</h1>
        <p className="muted">手机远控电脑上的 Kimi Code 桌面版</p>
        {invalid && (
          <p className="error-note">钥匙无效（应为 32 字节 base64url），已清除本地存储。请重新扫码配对。</p>
        )}
        <ol>
          <li>在电脑上进入 Kimi Code 项目目录，运行 <code>npm install &amp;&amp; npm start</code></li>
          <li>终端会打印<b>配对二维码 / 配对地址</b>（形如 <code>http://192.168.x.x:7777/#k=…</code>）</li>
          <li>用手机摄像头扫码，或把配对地址完整复制到手机浏览器打开（4G/WiFi 均可，公网地址走加密隧道）</li>
        </ol>
        <p className="muted small">
          配对地址 <code>#k=</code> 后面的部分就是你唯一的钥匙：谁能解密这台 bridge 的流量，谁就是自己人。
          不要把完整配对地址发给别人；钥匙泄露时删除电脑项目根目录的 <code>.kimi-remote.json</code> 并重启
          bridge 即可换新钥匙。
        </p>
      </div>
    </div>
  );
}
