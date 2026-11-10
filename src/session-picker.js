'use strict';
const { cleanTitle } = require('./core');

function pickConversation(vscode, providerName, sessions) {
  return new Promise(resolve => {
    const picker = vscode.window.createQuickPick();
    picker.title = `Add ${providerName} Session`;
    picker.placeholder = 'Type a name to create a new conversation, or select a saved conversation';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let result;
    const update = () => {
      const name = cleanTitle(picker.value);
      const create = {
        label: name ? `$(add) ${name}` : '$(add) Create New Session',
        description: name ? 'Create new session' : 'Start a separate conversation',
        create: true,
        name,
        alwaysShow: true
      };
      picker.items = [create, ...sessions.map(session => ({ label:session.title, description:session.cwd, detail:session.sessionId, session })),
        {label:'$(edit) Enter a session ID', manual:true, alwaysShow:true}];
      if (name) picker.activeItems = [create];
    };
    const subscriptions = [
      picker.onDidChangeValue(update),
      picker.onDidAccept(() => { result = picker.selectedItems[0] || picker.activeItems[0]; if (result) picker.hide(); })
    ];
    subscriptions.push(picker.onDidHide(() => {
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
      resolve(result);
    }));
    update();
    picker.show();
  });
}
module.exports = { pickConversation };
