import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { PanelApp } from './PanelApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.hash === '#panel' ? <PanelApp /> : <App />}
  </StrictMode>,
);
