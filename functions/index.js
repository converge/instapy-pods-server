// declarations
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sh = require('shorthash');
// set CORS
const cors = require('cors')({
  origin: true,
});
const axios = require('axios');
const luxon = require('luxon');
const serviceAccount = require('./serviceAccountKey.json');

const postPerDayRestriction = 5; // 5 posts per day
// set available topics
const topics = [
  'general',
  'beauty',
  'food',
  'travel',
  'sports',
  'entertainment',
];
// set modesAvailable
const modesAvailable = ['light', 'normal', 'heavy'];

// instantiate FireStore
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
db.settings({ timestampsInSnapshots: true });

/*
 * Get Recent Posts
 */
module.exports.getRecentPosts = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    if (topics.indexOf(req.query.topic) === -1) {
      res.status(403).send(
        `Invalid topic. Allowed topics on this server
        are : ${topics.join(',')}`,
      );
    }
    const collRef = db.collection(req.query.topic);
    collRef
      .get()
      .then((snapshot) => {
        const posts = [];
        snapshot.forEach((doc) => {
          console.log(doc.id, '=>', doc.data());
          console.log('_updateTime:', doc._updateTime._seconds);
          posts.push(doc.data().postid);
        });
        res.status(200).send(posts);
      })
      .catch((err) => {
        console.log('Error getRecentPosts', err);
        res.status(403).send(err);
      });
  });
});

/*
 * Get Recent Posts V1
 */
module.exports.getRecentPostsV1 = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    if (topics.indexOf(req.query.topic) === -1) {
      res.status(403).send(
        `Invalid topic. Allowed topics on this server are : 
        ${topics.join(',')}`,
      );
    }
    const collRef = db.collection(req.query.topic);
    collRef
      .get()
      .then((snapshot) => {
        const posts = [];
        snapshot.forEach((doc) => {
          console.log(doc.id, '=>', doc.data());
          console.log('_updateTime:', doc._updateTime._seconds);
          posts.push(doc.data());
        });
        res.status(200).send(posts);
      })
      .catch((err) => {
        console.log('Error getRecentPosts', err);
        res.status(403).send(err);
      });
  });
});


const getInstagramUsername = async (postId) => {
  const response = await axios.get(`https://www.instagram.com/p/${postId}/`);
  try {
    if (response.status === 200) return response.data.match(/(?<=alternateName":"@).+?(?=")/);
  } catch (err) {
    console.log(err);
    return null;
  }
};


const updateUsernameDailyLimit = async (username) => {
  const collRef = await db.collection('users');
  const userData = await collRef.orderBy('created', 'desc').limit(1).get();
  let postAge = null;
  let dailyLimit = null;
  if (!userData.empty) {
    userData.forEach((doc) => {
      dailyLimit = doc.get('daily_limit');
      let mostRecent = doc.get('created').toDate();
      mostRecent = luxon.DateTime.fromJSDate(mostRecent);
      const now = luxon.DateTime.fromJSDate(new Date());
      postAge = now.diff(mostRecent, 'days').toObject().days;
    });
  } else {
    // force new publish post date record
    postAge = 2;
  }
  // if first last published post is older than one day, create a new daily post record
  if (postAge > 1) {
    // create new daily record
    collRef.add({
      username,
      daily_limit: 0,
      created: new Date(),
    });
    return true;
  }

  // update
  if (dailyLimit >= postPerDayRestriction) {
    return false;
  }
  // add 1 to daily limit
  dailyLimit += 1;
  userData.forEach((doc) => {
    collRef.doc(doc.id).update({ daily_limit: dailyLimit });
  });
  return true;
};

/**
 * Publish PostId to the Pod Server
 * @validations:
 * 1. collect username
 * 2. check post daily limit per user
 * 3. publish if allowed
 */
module.exports.publishPost = functions.https.onRequest(async (req, res) => {
  const { postid, topic, mode } = req.query;
  const username = await getInstagramUsername(postid);
  let allowToPublishNewPost = false;
  // raise 403 status if it was unable to find the username
  if (username === null) res.status(403).send('Unable to load username');
  allowToPublishNewPost = await updateUsernameDailyLimit(username);

  return cors(req, res, () => {
    if (topics.indexOf(topic) === -1) {
      res.status(403).send(
        `Invalid topic. Allowed topics on this server are : 
        ${topics.join(',')}`,
      );
    }

    if (!allowToPublishNewPost) {
      res.status(403).send(
        `Daily Pod Publish limit reached in this server for username: ${username}`,
      );
    }
    const hashedpostid = sh.unique(postid);
    console.log('New Post added to the Pod with PostId: ', hashedpostid);
    const doctRef = db.collection(topic).doc(hashedpostid);

    let currentMode = 'normal';
    if (mode && modesAvailable.indexOf(mode) >= 0) {
      currentMode = req.query.mode;
    }
    doctRef
      .set({
        mode: currentMode,
        postid,
      })
      .then(() => {
        res
          .status(200)
          .send(`hashed: ${hashedpostid} actual: ${postid} username: ${username}`);
      })
      .catch((err) => {
        console.log('Error publishMyLatestPost', err);
        res.status(403).send(err);
      });
  });
});

/*
 * Delete Old Posts
 */
module.exports.deleteOlderPosts = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    if (topics.indexOf(req.query.topic) === -1) {
      res.status(403).send(
        `Invalid topic. Allowed topics on this server are : 
        ${topics.join(',')}`,
      );
    }
    const hourDeltainSec = 60 * 60 * 12;
    const nowinSec = +new Date() / 1000;
    const collRef = db.collection(req.query.topic);
    collRef
      .get()
      .then((snapshot) => {
        const posts = [];
        snapshot.forEach((doc) => {
          if (doc._updateTime._seconds < nowinSec - hourDeltainSec) {
            console.log('Deleting: ', doc.id);
            doc.ref.delete();
            posts.push(`Deleted: ${doc.id}`);
          } else {
            console.log('This is recent:', doc.id);
            posts.push(`recent: doc.id : ${doc._updateTime._seconds}`);
          }
        });
        res.status(200).send(posts);
      })
      .catch((err) => {
        console.log('Error getRecentPosts', err);
        res.status(403).send(err);
      });
  });
});

/*
 * InstaPost ?
 * TODO: improve function name
 */
module.exports.instapost = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    if (topics.indexOf(req.query.topic) === -1) {
      res.status(403).send(
        `Invalid topic. Allowed topics on this server are : 
        ${topics.join(',')}`,
      );
    }
    const doctRef = db.collection(req.query.topic).doc(req.query.hashedpostid);
    doctRef
      .get()
      .then((doc) => {
        if (!doc.exists) {
          console.log('No such document!');
        } else {
          console.log('Document data:', doc.data());
          res.redirect(`https://instagram.com/p/' ${doc.data().postid}`);
        }
      })
      .catch((err) => {
        console.log('Error getting document', err);
      });
  });
});
