import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installErrorReports } from './report';
import './styles.css';
import './moon.css';
import './controls.css';
import './worldshape.css';
import './party.css';
import './mobile.css';
import { trackVisibleViewport } from './platform';

installErrorReports();
trackVisibleViewport();
createRoot(document.getElementById('root')!).render(<App />);
