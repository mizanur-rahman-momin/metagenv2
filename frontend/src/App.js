import "@/App.css";
import MetaGenerator from "@/components/MetaGenerator";
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <div className="App">
      <MetaGenerator />
      <Toaster position="bottom-right" theme="dark" />
    </div>
  );
}

export default App;
