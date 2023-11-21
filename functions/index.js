// Imports the Firebase Admin SDK
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');

// Initializes the app with a service account
admin.initializeApp({
    credential: admin.credential.applicationDefault()
});

const db = admin.firestore();

exports.onUserCreated = functions.auth.user().onCreate((user) => {
    return admin.firestore().collection('users').doc(user.uid).set({
        email: user.email,
        uid: user.uid,
        joined: Timestamp.now(),
        subscriptionStatus: 'trial',
    }).then((_) => resetBalance(user.uid, 10000));
});

exports.onUserDeleted = functions.auth.user().onDelete((user) => {
    return admin.firestore().collection('users').doc(user.uid).update({
        accountStatus: 'deleted',
        subscriptionStatus: 'canceled',
    });
});

exports.resetDashboard = functions.https
    .onCall((data, context) => {
        resetBalance(data['userId'], data['newBalance'])
    });

exports.createMasterTrade = functions.https
    .onCall((data, context) => {
        // Logs a message with the document ID and data
        const doc = db.collection('master_trades').doc();
        console.log(`Creating new master trade ${doc.id} `, data);

        // calculate risk and reward
        const price = data['price'];
        const tp = data['tp'];
        const sl = data['sl'];
        const type = data['type'];

        var riskPips = 0;
        var rewardPips = 0;
        if (type === 'Buy') {
            riskPips = price - sl;
            rewardPips = tp - price;
        } else if (type === 'Sell') {
            riskPips = sl - price;
            rewardPips = price - tp;
        }

        const rr = rewardPips / riskPips;

        const newData = {
            'rr': rr,
            'type': type,
            'sl': sl,
            'tp': tp,
            'price': price,
            'status': 'active',
            'timestamp': Timestamp.now(),
        };

        // create the document
        doc.set(newData).then(() => {
            // Logs a success message
            console.log(`Created trade ${doc.id}`, newData);
            console.log(`Creating child trades`);
            createChildTrades(doc.id);
        })
            .catch((error) => {
                // Logs an error message
                console.error(`Failed to update trade ${doc.id}`, error);
            });

        return null; // Return null to indicate successful execution
    });

exports.onMasterTradeUpdated = functions.firestore
    .document('master_trades/{id}')
    .onUpdate((snapshot, context) => {

        const data = { 'status': snapshot.after.data()['status'] };

        console.log(`Cascading master update to child trades ${snapshot.id} `, data);
        updateChildTrades(snapshot.after.id, data);

        return null; // Return null to indicate successful execution
    });

exports.monthlyTask = functions.pubsub.schedule('0 0 1 * *')
    .timeZone('UTC') // Users can choose timezone - default is America/Los_Angeles
    .onRun((context) => {
        startNewMonth();
        return null;
    });

function createChildTrades(masterId) {
    db.collection('master_trades').doc(masterId).get()
        .then((snapshot) => {
            const masterData = snapshot.data();
            console.log(`got masterData`, masterData);
            // Queries all users that have a subscriptionStatus of 'trial' or 'active'
            db.collection('users').where('subscriptionStatus', 'in', ['trial', 'active']).get()
                .then((querySnapshot) => {
                    // Loop through each document and update it with the new data
                    console.log(`looping through fetched users of length: ${querySnapshot.docs}`);
                    querySnapshot.docs.forEach((doc) => {
                        // Get the current balance

                        const currentBalance = doc.data()['currentBalance'] ?? 0;
                        console.log(`got current balance`, currentBalance);
                        const risk = 0.01 * currentBalance;
                        console.log(`calculated risk`, risk);
                        const rr = masterData.rr ?? 0;
                        const reward = risk * rr;
                        console.log(`calculated reward`, reward);

                        const newData = {
                            'parentId': masterId,
                            'risk': risk,
                            'reward': reward,
                            'type': masterData['type'],
                            'sl': masterData['sl'],
                            'tp': masterData['tp'],
                            'price': masterData['price'],
                            'rr': masterData['rr'],
                            'status': masterData['status'],
                            'timestamp': Timestamp.now(),
                        }

                        // Create a new trade with the new data
                        doc.ref.collection('trades').add(newData)
                            .then(() => {
                                // Logs a success message
                                console.log(`Created child for master ${masterId} for user ${doc.id}`);
                                updateDashboard(doc.id, { currentTotalTrades: 1 })
                            })
                            .catch((error) => {
                                // Logs an error message
                                console.error(`Failed to create child trade for master ${masterId} for user ${doc.id}`, error);
                            });
                    });
                })
                .catch((error) => {
                    // Logs an error message
                    console.error(`Failed to query users collection: ${error}`);
                });
        })
        .catch((error) => {
            console.error(`Failed to load master trade ${masterId} for creating child documents`, error);
        });

}

function updateChildTrades(masterId, newData) {
    db.collectionGroup('trades').where('parentId', '==', masterId).get()
        .then((querySnapshot) => {
            // Loop through each document and update it with the new data
            console.log(`looping through fetched trades of length: ${querySnapshot.docs}`);
            querySnapshot.docs.forEach((doc) => {

                var amount = 0, isProfit;
                if ((newData['status'] ?? '').toLowerCase() === 'win') {
                    amount = doc.data()['reward'];
                    isProfit = true;
                } else {
                    amount = doc.data()['risk'];
                    isProfit = false;

                }

                // Create a new trade with the new data
                doc.ref.update(newData)
                    .then(() => {
                        // don't log to reduce log spam
                        console.log('Updating dashboard')
                        calculateAndUpdateDashboardValues(doc.ref, isProfit ? amount : -amount);
                    })
                    .catch((error) => {
                        // Logs an error message
                        console.error(`Failed to update child trade ${doc.id} for master ${masterId} for user ${doc.id}`, error);
                    });
            });
        })
        .catch((error) => {
            // Logs an error message
            console.error(`Failed to query trades collection: ${error}`);
        });


}

function clearTrades(userId) {
    console.log('Deleting trades for user: ', userId);
    db.collection('users').doc(userId).collection('trades').get().then((snapshot) => {
        snapshot.docs.forEach((doc) => {
            doc.ref.delete().catch((error) => {
                console.log(`Failed to delete trade ${doc.id} for user ${userId}`);
            })
        })
    }).catch((error) => {
        console.log(`failed to load trades for user ${userId} for deletion`);
    });
}

function resetBalance(userId, newBalance) {
    Promise.all([
        db.collection('dashboards').doc(userId).set({ currentBalance: newBalance, balances: [newBalance] }),
        db.collection('users').doc(userId).update({ currentBalance: newBalance }),
    ]).then((value) => {
        console.log('Dashboard and User balance updated successfully');
        clearTrades(userId);
    }).catch((error) => {
        console.log('Failed to updated dashboard and user balance');
    });
}

function appendUserBalance(userId, amount) {
    console.log('updating balance for user ', userId);
    db.collection('users').doc(userId).get().then((snapshot) => {
        const newBalance = snapshot.data()['currentBalance'] + amount;
        db.collection('users').doc(userId).update({ currentBalance: newBalance })
            .then((value) => {
                console.log('User balance updated successfully');
            }).catch((error) => {
                console.log('Failed to update user balance');
            }).catch((error) => {
                console.log('Failed to load user balance for update');
            });
    });
}

function calculateAndUpdateDashboardValues(reference, amount) {
    const userId = reference.path.split("/")[1];

    appendUserBalance(userId, amount);
    updateDashboard(userId, { currentBalance: amount, currentTotalWins: amount > 0, currentTotalLosses: amount < 0, currentTotalBreakevens: amount === 0 })

}

function updateDashboard(userId, { currentTotalTrades, currentBalance, currentTotalWins, currentTotalLosses, currentTotalBreakevens }) {
    console.log('updating dashboard for user: ', userId);
    db.collection('dashboards').doc(userId).get()
        .then((snapshot) => {
            data = snapshot.data();

            if (currentTotalTrades) {
                data['currentTotalTrades'] += 1;
                data['currentActiveDays'] += 1;
            }
            if (currentBalance) {
                data['prevBalance'] = data['currentBalance'];
                data['currentBalance'] += currentBalance;
                var balances = data['balances'] ?? [];
                balances = [...balances, data['currentBalance']];
                data['balances'] = balances;
            }
            if (currentTotalWins) {
                data['currentTotalWins'] = (data['currentTotalWins'] ?? 0) + 1;
                data['currentWinStreak'] = (data['currentWinStreak'] ?? 0) + 1;
            }
            if (currentTotalLosses) {
                data['currentTotalLosses'] = (data['currentTotalLosses'] ?? 0) + 1;
                data['currentWinStreak'] = 0;
            }
            if (currentTotalBreakevens) {
                data['currentTotalBreakevens'] = (data['currentTotalBreakevens'] ?? 0) + 1;
            }

            snapshot.ref.update(data).then((_) => {
                console.log('dashboard updated successfully');
            }).catch((error) => {
                console.log('failed to update dashboard', error);
            })
        })
        .catch((error) => {
            console.log(`Failed to load dashboard ${userId} for update`, error);

        });
}

function startNewMonth() {
    console.log('Staring new month');
    console.log('Pushing data to prevMonth');
    db.collection('dashboards').get().then((querySnapshot) => {
        querySnapshot.docs.forEach((doc) => {
            var data = doc.data();
            data['balances'] = cutOff(data['balances']);
            data['currentBalance'] = data['prevBalance'];
            data['prevMonthTotalTrades'] = data['currentTotalTrades'];
            data['prevMonthWinStreak'] = data['currentWinStreak'];
            data['prevMonthActiveDays'] = data['currentActiveDays'];
            data['prevMonthTotalWins'] = data['currentTotalWins'];
            data['prevMonthTotalLosses'] = data['currentTotalLosses'];
            data['prevMonthTotalBreakevens'] = data['currentTotalBreakevens'];
        })
    })
        .catch((error) => {
            console.log('Failed to query dashboards', error);
        })
}

function cutOff(array) {
    if (array.length > 100) {
      let startIndex = array.length - 100;
      let newArray = array.slice(startIndex);
      return newArray;
    } else {
      return array;
    }
  }
  