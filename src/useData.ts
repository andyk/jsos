import { useContext } from "react";

import { DataContext } from "./JsosContext";

const useData = () => {
  const context = useContext(DataContext);

  if (context === undefined) {
    throw new Error("useData must be used inside a DataProvider");
  }

  return context;
};

export default useData;