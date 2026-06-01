import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import App from './App'

// Mock useOffice hook
vi.mock('./office/useOffice', () => ({
  useOffice: vi.fn(),
}))

// Mock TaskPane component
vi.mock('./components/TaskPane', () => ({
  TaskPane: ({ host }: { host: string | null }) => (
    <div data-testid="task-pane">TaskPane host={host}</div>
  ),
}))

// The DebugPanel must never render itself by default. The App-level test
// imports the real one (it's just a presentational component) and asserts
// visibility via its sticky header "DBG dbg-2".
vi.mock('./components/DebugPanel', () => ({
  DebugPanel: () => <div data-testid="debug-panel">debug panel</div>,
}))

import { useOffice } from './office/useOffice'
const mockUseOffice = vi.mocked(useOffice)

describe('App loading and error states', () => {
  it('shows loading state when Office is not ready', () => {
    mockUseOffice.mockReturnValue({ isReady: false, host: null, error: null })
    render(<App />)
    expect(screen.getByText(/Loading Office Add-in/)).toBeInTheDocument()
  })

  it('shows error message when Office fails to initialize', () => {
    mockUseOffice.mockReturnValue({
      isReady: false,
      host: null,
      error: 'Office.js failed to load',
    })
    render(<App />)
    expect(screen.getByText('Office.js failed to load')).toBeInTheDocument()
  })

  it('applies destructive text color to error message', () => {
    mockUseOffice.mockReturnValue({
      isReady: false,
      host: null,
      error: 'Something went wrong',
    })
    render(<App />)
    const errorEl = screen.getByText('Something went wrong')
    expect(errorEl).toHaveClass('text-destructive')
  })

  it('does not render TaskPane while loading', () => {
    mockUseOffice.mockReturnValue({ isReady: false, host: null, error: null })
    render(<App />)
    expect(screen.queryByTestId('task-pane')).not.toBeInTheDocument()
  })

  it('prioritizes error over loading state', () => {
    mockUseOffice.mockReturnValue({
      isReady: false,
      host: null,
      error: 'Init failed',
    })
    render(<App />)
    expect(screen.getByText('Init failed')).toBeInTheDocument()
    expect(screen.queryByText(/Loading Office Add-in/)).not.toBeInTheDocument()
  })
})

describe('App ready state', () => {
  it('renders TaskPane with host when Office is ready', () => {
    mockUseOffice.mockReturnValue({
      isReady: true,
      host: 'Outlook',
      error: null,
    })
    render(<App />)
    expect(screen.getByTestId('task-pane')).toBeInTheDocument()
    expect(screen.getByText('TaskPane host=Outlook')).toBeInTheDocument()
  })

  it('renders TaskPane with browser host in dev mode', () => {
    mockUseOffice.mockReturnValue({
      isReady: true,
      host: 'browser',
      error: null,
    })
    render(<App />)
    expect(screen.getByText('TaskPane host=browser')).toBeInTheDocument()
  })
})

describe('App debug-panel hotkey gate', () => {
  // Standing rule (user-stated): the DebugPanel is HIDDEN by default in every
  // environment. The only way to surface it is the Ctrl+Alt+D hotkey.
  it('does not render the DebugPanel by default', () => {
    mockUseOffice.mockReturnValue({ isReady: true, host: 'Outlook', error: null })
    render(<App />)
    expect(screen.queryByTestId('debug-panel')).not.toBeInTheDocument()
  })

  it('does not mount a dev theme toggle (TaskPane owns the single control)', () => {
    mockUseOffice.mockReturnValue({ isReady: true, host: 'Outlook', error: null })
    render(<App />)
    expect(document.querySelector('#dev-dark-toggle')).not.toBeInTheDocument()
  })

  it('toggles the DebugPanel on/off when Ctrl+Alt+D is pressed', () => {
    mockUseOffice.mockReturnValue({ isReady: true, host: 'Outlook', error: null })
    render(<App />)

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, altKey: true })
    expect(screen.getByTestId('debug-panel')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, altKey: true })
    expect(screen.queryByTestId('debug-panel')).not.toBeInTheDocument()
  })
})
