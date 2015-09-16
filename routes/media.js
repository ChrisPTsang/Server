var express = require('express');
var router  = express.Router();
var multer  = require('multer');
var aws     = require('aws-sdk');
var request = require('request');
var crypto  = require('crypto');
var mime    = require('mime');
var im = require('imagemagick');

// Models
var Comment = require('./../db/Comment');
var Medium  = require('./../db/Medium');
var Venue   = require('./../db/Venue');
var User    = require('./../db/User');

if(!(process.env.production || process.env.TRAVIS)) var config = require('../config');

// Setting up AWS Credentials
var AWS_ACCESS_KEY = process.env.S3_ACCESS || config.aws.access;
var AWS_SECRET_KEY = process.env.S3_SECRET || config.aws.secret;
var S3_BUCKET = 'persnickety/media';

// Returns a list of media for a venue
router.get('/', function (req, res) {
  var mediaList = [];
  Medium.find({'venue': req.query.venue}, function(err, media) {
    if (media) {
      media.forEach(function(medium) {
        if (medium.path !== undefined) mediaList.push(medium);
      });
      res.send(mediaList);
    }
    else {
      res.status(404).send('Venue not found!');
    }
  });
});

router.get('/:id', function (req, res) {
  var medium_id = req.params.id;
  Medium.findById(medium_id).populate('creator').populate('venue')
  .exec(function (err, medium) {
    res.send(medium);
  });
});

var storage = multer.memoryStorage(); // Stores uploaded files in memory/buffer
router.post('/', multer({ storage: storage }).single('file'), function (req, res, next) {

  aws.config.update({accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY});
  var s3bucket = new aws.S3({params: {Bucket: S3_BUCKET}});

  // Generate random filename
  crypto.pseudoRandomBytes(8, function (err, raw) {
    if (raw && req.file) {
      var filename = raw.toString('hex') + '.' + mime.extension(req.file.mimetype);
      var filenameThumb = raw.toString('hex') + 'thumb' + '.' + mime.extension(req.file.mimetype);

      // S3 urls for thumbnail and fullsize photo
      var thumbnailUrl = '';
      var photoUrl = '';

      // resize for thumbnails
      im.resize({
          srcData : req.file.buffer,
          width : 100,
          height : '100^',
          format: 'jpg',
          customArgs: [
            '-gravity', 'center', '-extent', '100x100'
          ]
      }, function(err, stdout, stderr) {
        if (err){
            console.log('error resizing');
        } else {
          // Upload thumbnail to AWS
          var buffer = new Buffer(stdout,'binary');
          s3bucket.createBucket(function() {
            var params = {Key: filenameThumb, Body: buffer};
            s3bucket.upload(params, function(err, data) {
              if (err) {
                console.log('Error uploading data: ', err);
                res.status(500).end();
              } else {
                thumbnailUrl = data.Location;

                // Upload to full-size photo to AWS
                s3bucket.createBucket(function() {
                  var params = {Key: filename, Body: req.file.buffer};
                  s3bucket.upload(params, function(err, data) {
                    if (err) {
                      console.log('Error uploading data: ', err);
                      res.status(500).end();
                    } else {
                      photoUrl = data.Location;

                      console.log(thumbnailUrl);
                      console.log(photoUrl);

                      // Creating new Medium
                      var addMedium = Medium.create({
                        // Todo: AWS passes back a partially encoded URL, 
                        // this should be decoded but doesn't really matter
                        path: photoUrl,
                        thumbPath: thumbnailUrl,
                        creator: req.body.creator,
                        venue: req.body.venue,
                        datetime: new Date(),
                        atVenue: req.body.atVenue || false,
                        mimetype: req.file.mimetype
                      },
                      // Adding Medium to Venue
                      function(err, newMedium) {
                        if (newMedium) {
                          Venue.findById(req.body.venue, function(err, venue) {
                            if (venue) {
                              venue.media.push(newMedium._id);
                              venue.save(function(err) {
                                if (err) console.log(err);
                                else {
                                  // emit socket event for new media added
                                  global.socket.emit('media-' + req.body.venue, newMedium);
                                  res.status(200).send(newMedium.path);
                                }
                              });
                            } else {
                              console.log(err);
                            }
                          });
                        }
                        if (err) {
                          res.status(500).send(err);
                        }
                      });
                    }
                  });
                });
              }
            });
          });
        }
      });
    } // if (raw)
    else {
      res.status(500).send('No data received...');
    }
  });
});

router.post('/flag/:id', function (req, res) {
  var medium_id = req.params.id;
  if (req.body.shouldDelete === false) {
    Medium.findById(medium_id).then(function(medium) {
      medium.flags = req.body.flags;
      medium.markModified('flags');
      medium.save().then(function() {res.send(medium)});
    })
    .catch(function(err) {
      console.log(err);
    });
  } else {
    Medium.remove({_id: medium_id}, function(err) {
      if (err) {
        console.log(err);
      } else {
        res.send('');
      }
    });
  }
});

module.exports = router;
