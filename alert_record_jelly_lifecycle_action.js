const AWS = require('aws-sdk');
const cfg = { region: 'cn-northwest-1' };
AWS.config.update(cfg);

const S3 = new AWS.S3(cfg);
const EC2 = new AWS.EC2(cfg);
const SNS = new AWS.SNS(cfg);

// 16 * 15 = 240 minutes, 4 hours
const countThreshold = 16;
const bucket = "bucket";
const prefix = "RecordJellyInstanceHeartbeat/counter_";
const instanceTerminatedCode = 48;

const alertTopicArn = "topic";
const subjectStr = "[Alert]: Instance Log Not Fully Uploaded to S3."

const alertTagKey = "Alert";
const alertTagKeyValueAlert = "1";
const alertTagKeyValueClear = "0";

exports.handler = async(event) => {
    let listObjResponse = await ListObject(bucket, prefix);
    //console.log("listobj response: ", listObjResponse);
    let listObjContents = listObjResponse.Contents;
    let listObjContentsLen = listObjResponse.Contents.length;
    // if get one or more instance alert counter, then check if Counter.Count > countThreshold
    if (listObjContentsLen >= 1) {
        for (let i = 0; i < listObjContentsLen; i++) {
            let DescribeInstancesResponse;
            let key = listObjContents[i].Key;
            let counterContent = await GetS3FileContent(bucket, key);
            console.log(`--> [Info]: alert counter content: [${JSON.stringify(counterContent)}]`);

            // if Count >= countThreshold, then publish message
            if (counterContent.Count >= countThreshold) {
                let message = { "AlertInstanceTrigger": JSON.stringify(counterContent) };
                console.log(`--> [Alert]: Publish alert message [${JSON.stringify(message)}] to topic [${alertTopicArn}]`);
                let publishMsgResponse = await PublishMessage(alertTopicArn, subjectStr, JSON.stringify(message));
                console.log("--> [Info]: publishMsgResponse: ", publishMsgResponse);
                if (publishMsgResponse != undefined) {
                    console.log(`--> [Info]: Published alert message to topic [${alertTopicArn}]`);
                }
                // check current alerting instance status
                if (counterContent.InstanceId != undefined) {
                    DescribeInstancesResponse = await DescribeInstances(counterContent.InstanceId);
                }
                // if instance is in terminated status or not exist, del the s3 counter trigger
                if (DescribeInstancesResponse.Reservations[0].Instances.length == 0 ||
                    DescribeInstancesResponse.Reservations[0].Instances[0].State.Code == instanceTerminatedCode) {
                    // del s3 counter trigger
                    let DeleteS3FileResponse = await DeleteS3File(bucket, key);
                    console.log("--> [Info]: DeleteS3FileResponse: ", DeleteS3FileResponse);
                }
            }
            else {
                console.log(`--> [Warning]: There is a potential alert. Record count is: ${counterContent.Count}`);
            }
        }
    }
    else {
        console.log("--> [Info]: There is no alert.");
    }
};

// list a specific obj
async function ListObject(bucketName, keyPrefix) {
    let response;
    var params = {
        Bucket: bucketName,
        Delimiter: '/',
        MaxKeys: 10,
        Prefix: keyPrefix
    };
    //console.log("listobj input: ", params);
    try {
        response = await S3.listObjectsV2(params).promise();
    }
    catch (error) {
        console.log("--> [Error]: list obj error:", error);
    }

    return response;
}

// Get a file's content
async function GetS3FileContent(bucketName, keyName) {
    let getObjResponsePart;
    let getS3FileContentInput = {
        Bucket: bucket,
        Key: keyName,
    };

    //console.log("Get S3 file content: ", getS3FileContentInput.Key);
    try {
        let response = await S3.getObject(getS3FileContentInput).promise();
        getObjResponsePart = JSON.parse(response.Body);
    }
    catch (error) {
        console.log("--> [Error]: get s3 object content error: ", error);
    }

    return getObjResponsePart;
}

// publish sns message to a topic
async function PublishMessage(topicArnStr, subject, message) {
    let response;
    let d = new Date();
    var params = {
        Message: message,
        MessageAttributes: {
            'date': {
                DataType: 'String',
                StringValue: d.toString()
            }
        },
        Subject: subject,
        TopicArn: topicArnStr
    };

    try {
        response = await SNS.publish(params).promise();
    }
    catch (error) {
        console.log("--> [Error]: publish message error: ", error);
    }
    return response;
}

// DescribeInstances encapsulate ec2.describeInstances()
// instanceId: response.Reservations[0].Instances[0].PrivateIpAddress
// response.Reservations[0].Instances[0].State: { Code: 16, Name: 'running' } , // 48 (terminated)
async function DescribeInstances(instanceID) {
    var params = {
        InstanceIds: [
            instanceID
        ]
    };

    let response = await EC2.describeInstances(params).promise();

    return response;
}

// del a s3 obj
async function DeleteS3File(bucketName, keyName) {
    let response;
    var params = {
        Bucket: bucketName,
        Delete: {
            Objects: [{
                Key: keyName
            }],
            Quiet: false
        }
    };

    try {
        response = S3.deleteObjects(params).promise();
    }
    catch (error) {
        console.log("delete s3 file error: ", error);
    }

    return response;
}
