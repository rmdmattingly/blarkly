import { Link, NavLink } from 'react-router-dom';

const GameNav = () => {
  return (
    <nav className="GameNav">
      <div className="GameNav-brand">
        <Link to="/" className="GameNav-logoLink" aria-label="Blarkly Games home">
          <img src="/logo.png" alt="Blarkly logo" className="GameNav-logo" />
        </Link>
      </div>
      <div className="GameNav-links">
        <NavLink to="/games/highlow" className={({ isActive }) => (isActive ? 'active' : undefined)}>
          High/Low
        </NavLink>
        <NavLink to="/games/oldmaid" className={({ isActive }) => (isActive ? 'active' : undefined)}>
          Old Maid
        </NavLink>
      </div>
    </nav>
  );
};

export default GameNav;
