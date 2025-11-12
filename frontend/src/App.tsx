import { BrowserRouter, Routes, Route } from 'react-router-dom';

import './App.css';
import Home from './pages/Home';
import HighLowLobby from './pages/HighLowLobby';
import OldMaidLobby from './pages/OldMaidLobby';
import OldMaidSession from './pages/OldMaidSession';
import Session from './pages/Session';

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/games/highlow" element={<HighLowLobby />} />
        <Route path="/games/oldmaid" element={<OldMaidLobby />} />
        <Route path="/session/:sessionId" element={<Session />} />
        <Route path="/old-maid/session/:sessionId" element={<OldMaidSession />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
