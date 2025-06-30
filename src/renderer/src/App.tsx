function App(): React.JSX.Element {
  const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')

  return (
    <>
      <button className="btn btn-primary" onClick={ipcHandle}>
        Default
      </button>
      <button className="btn btn-secondary" onClick={ipcHandle}>
        Secondary
      </button>
      <button className="btn btn-accent" onClick={ipcHandle}>
        Accent
      </button>
    </>
  )
}

export default App
