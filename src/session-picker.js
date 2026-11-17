'use strict';
const { t } = require('./localization');
const { cleanTitle } = require('./core');

function pickConversation(vscode, providerName, sessions) {
  return new Promise(resolve => {
    const picker = vscode.window.createQuickPick();
    picker.title = t('Add {0} Session', [providerName]);
    picker.placeholder = t('Type a name for a new conversation, or pick a saved one (reopens in its own folder)');
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let result;
    const update = () => {
      const name = cleanTitle(picker.value);
      const create = {
        label: name ? `$(add) ${name}` : '$(add) ' + t('Create New Session'),
        description: name ? t('Create new session') : t('Start a separate conversation'),
        create: true,
        name,
        alwaysShow: true
      };
      picker.items = [create, ...sessions.map(session => ({ label:session.title, description:session.cwd, detail:session.sessionId, session })),
        {label:'$(edit) ' + t('Enter a session ID'), manual:true, alwaysShow:true}];
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
