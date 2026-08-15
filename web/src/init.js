    initPush();

    loadPairs();
    loadPins();
    loadAgentOrder();
    loadSeen();
    measureCellRatio();  // before applyWrapMode, which divides by it
    setFont(currentFont());
    setInputFont(currentInputFont());
    setConvFont(currentConvFont());
    applyWrapMode();
    placePairStrip();
    initConvDock();      // the conversation window's floating dock, from here on
    syncQaBtn();
    syncBottomDock();
    setDictationEnabled(dictationOn());  // hidden unless asked for, and where there is no speech recognition
    document.getElementById('historyPick').value = String(paneHistoryMax());
    setConvDeepAll(convDeepAll());
    setConvTidy(convTidyOn());
    setDockMru(dockMruOn());
    setAutocorrect(autocorrectOn());
    setBandwidthOn(bandwidthOn());
    syncBandwidthRange();
    setConvSweep(localStorage.getItem('herdr_conv_sweep') || '1h');
    loadTermShortcuts();
    syncPromptsBtn();  // no pane is open yet, so this labels the button for an agent
    // The list is where the session starts, and the walk has to start there too — otherwise Back
    // from the first pane opened has nowhere to go and the browser's own Back would leave the app
    // rather than closing the pane.
    noteLandingNav();
  
