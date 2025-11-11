import { render, screen } from '@testing-library/react';
import App from './App';

test('renders player name prompt', () => {
  render(<App />);
  const label = screen.getByLabelText(/player name/i);
  expect(label).toBeInTheDocument();
});
