import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AlreadyRunning } from './ui/AlreadyRunning';
import { acquireUi, takeOverUi } from './desktop/singleInstance';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

const renderApp = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// 「こちらで使う」で別の画面に切り替えられた：この画面の待機・マイクを確実に止めるため、読み込み直して案内表示にする
const onLost = () => {
  try {
    sessionStorage.setItem('pva.uiStolen', '1');
  } catch {
    /* 表示の違いだけ */
  }
  location.reload();
};

const renderBusy = () => {
  let stolen = false;
  try {
    stolen = sessionStorage.getItem('pva.uiStolen') === '1';
    sessionStorage.removeItem('pva.uiStolen');
  } catch {
    /* 表示の違いだけ */
  }
  root.render(<AlreadyRunning stolen={stolen} onTakeOver={() => void takeOverUi(onLost).then(renderApp)} />);
};

void acquireUi(onLost).then((r) => (r === 'owner' ? renderApp() : renderBusy()));
