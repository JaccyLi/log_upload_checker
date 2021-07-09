const AWS = require('aws-sdk');
const cfg = { region: 'cn-northwest-1' };
AWS.config.update(cfg);

let S3 = new AWS.S3(cfg);
let EC2 = new AWS.EC2(cfg);
let Autoscaling = new AWS.AutoScaling(cfg);

const bucket = "bucket";
// const triggerKey = "jelly/RecordJellyInstanceHeartbeat/trigger.json";
const lifecycleHook = "close";
const instanceTerminatedCode = 48;

const alertTagKey = "Alert";
const alertTagKeyValueAlert = "1";
const alertTagKeyValueClear = "0";
const instanceAutoscalingGroupKeyName = "aws:autoscaling:groupName";

// autoscling instance lifecycle hook duration is 7200s, that's 2 hours;
const hookDuration = 2;
// This lambda will be executed every ${lambdaInvokeInterval} minutes
// const lambdaInvokeInterval = 15;

// Handler entry
exports.handler = async function(event, context, callback) {

    // get instances which contain alertTagKey
    let describeTagsResponse = await DescribeInstanceTags(alertTagKey, alertTagKeyValueAlert, alertTagKeyValueClear);
    console.log("instances with Alert tag is: ", describeTagsResponse.Tags);
    console.log("Alert tags described: ", describeTagsResponse.Tags.length);
    let alertingInstanceInfo = describeTagsResponse.Tags;
    let alertingInstances = describeTagsResponse.Tags.length;

    // if alertTagKey is present, then get instanceID
    if (alertingInstances >= 1) {
        for (let i = 0; i < alertingInstances; i++) {
            let describeInstanceAsgTagsResponse;
            console.log(`the ${i}th alerting instance is ${alertingInstanceInfo[i].ResourceId}`);
            // get asg Name
            describeInstanceAsgTagsResponse = await DescribeInstanceAsgTags(instanceAutoscalingGroupKeyName, alertingInstanceInfo[i].ResourceId);
            console.log(`describeAsgTags response[${i}]`, describeInstanceAsgTagsResponse.Tags);
            let recordLifecycleActionHeartbeatResponse;
            let completeJellyInstanceLifecycleActionResponse;
            let descInstanceResponse = await DescribeInstances(alertingInstanceInfo[i].ResourceId);
            let instanceIPInput = descInstanceResponse.Reservations[0].Instances[0].PrivateIpAddress;
            let instanceStatusCode = descInstanceResponse.Reservations[0].Instances[0].State.Code;
            // if alertTagKeyValue is "1", then RecordJellyInstanceLifecycleHeartbeat
            if (alertingInstanceInfo[i].Value == '1') {

                if (describeInstanceAsgTagsResponse.Tags.length != 1) {
                    console.log("cant get autoscaling group name.");
                    return;
                }
                else {
                    // Terminated instance still exits for some time
                    if (instanceStatusCode != instanceTerminatedCode) {
                        // now we get asg Name, instance alertTagKeyValue is 1 and get instanceID, do RecordJellyInstanceLifecycleHeartbeat
                        console.log("--> alertTagKeyValue=1, do RecordJellyInstanceLifecycleHeartbeat.");
                        recordLifecycleActionHeartbeatResponse = await RecordJellyInstanceLifecycleHeartbeat(describeInstanceAsgTagsResponse.Tags[0].Value, lifecycleHook, alertingInstanceInfo[i].ResourceId);
                        console.log("recordLifecycleActionHeartbeatResponse: ", recordLifecycleActionHeartbeatResponse);
                    }
                    else if (instanceStatusCode == instanceTerminatedCode) {
                        console.log(`instance [${alertingInstanceInfo[i].ResourceId}] is already terminated, ignore it.`);
                    }
                }

                // if record lifecycle action heartbeat success, then update instance terminate info
                if (recordLifecycleActionHeartbeatResponse != undefined) {
                    // update term info
                    console.log("updating terminating info...");
                    let termInfo = await GetTerminateInfo(instanceIPInput, alertingInstanceInfo[i].ResourceId, bucket);
                    console.log("get term info: ", termInfo);
                    if (termInfo != undefined) {
                        let response = await UpdateTerminateInfo(termInfo, bucket);
                        console.log("updated terminate info: ", response);
                    }
                }
            }
            // if alertTagKeyValue is "0", then CompleteJellyInstanceLifecycleAction
            else if (alertingInstanceInfo[i].Value == '0') {
                // Terminated instance still exits for some time
                if (instanceStatusCode != instanceTerminatedCode) {
                    console.log("--> alertTagKeyValue=0, do CompleteJellyInstanceLifecycleAction.");
                    completeJellyInstanceLifecycleActionResponse = await CompleteJellyInstanceLifecycleAction(describeInstanceAsgTagsResponse.Tags[0].Value, lifecycleHook, alertingInstanceInfo[i].ResourceId);
                    console.log("completeJellyInstanceLifecycleActionResponse: ", completeJellyInstanceLifecycleActionResponse);
                }
                else if (instanceStatusCode == instanceTerminatedCode) {
                    console.log(`instance [${alertingInstanceInfo[i].ResourceId}] is terminated terminated, ignore it.`);
                }
            }
        }
    }
    else {
        let d = new Date();
        console.log(`[${d}]: there is no instance log upload alert.`);
        return;
    }

};

// DescribeInstanceTags describe ec2 instances tags
async function DescribeInstanceTags(tagKey, tagValueAlert, tagValueClear) {
    let response;
    var params = {
        Filters: [{
            Name: "tag:Alert",
            Values: [
                tagValueAlert,
                tagValueClear
            ]
        }]
    };

    try {
        response = await EC2.describeTags(params).promise();
    }
    catch (error) {
        console.log("describe instance tags error: ", error);
    }

    return response;
}

// DescribeInstanceAsgTags describe instance tag key's value
async function DescribeInstanceAsgTags(asgNameKey, instanceID) {
    let response;
    var params = {
        Filters: [{
                Name: "key",
                Values: [
                    asgNameKey
                ]
            },
            {
                Name: "resource-id",
                Values: [
                    instanceID
                ]
            }
        ]
    };

    try {
        response = await EC2.describeTags(params).promise();
    }
    catch (error) {
        console.log("describe instance tags error: ", error);
    }

    return response;
}

// RecordJellyInstanceHeartbeat do record instance heartbeat action
async function RecordJellyInstanceLifecycleHeartbeat(asgName, lifecycleHook, instanceID) {
    let response;
    var params = {
        AutoScalingGroupName: asgName,
        LifecycleHookName: lifecycleHook,
        InstanceId: instanceID
    };
    console.log("RecordJellyInstanceLifecycleHeartbeat input params: ", params);

    try {
        response = await Autoscaling.recordLifecycleActionHeartbeat(params).promise();
    }
    catch (error) {
        console.log("record instance lifecycle heartbeat action error: ", error);
    }

    return response;
}


// RecordJellyInstanceHeartbeat do record instance heartbeat action
async function CompleteJellyInstanceLifecycleAction(asgName, lifecycleHook, instanceID) {
    let response;
    // LifecycleActionResult: CONTINUE or ABANDON
    var params = {
        AutoScalingGroupName: asgName,
        LifecycleHookName: lifecycleHook,
        InstanceId: instanceID,
        LifecycleActionResult: 'ABANDON'
    };
    console.log("CompleteJellyInstanceLifecycleAction input params: ", params);

    try {
        response = await Autoscaling.completeLifecycleAction(params).promise();
    }
    catch (error) {
        console.log("complete instance lifecycle heartbeat action error: ", error);
    }

    return response;
}


// GetTerminateInfo get terminateInstanceInfo-${instanceIp}_${instanceId}.txt from s3
async function GetTerminateInfo(instanceIp, instanceId, bucket) {
    let getObjResponsePart;
    let getTermInfoInput = {
        Bucket: bucket,
        Key: `jelly/instance_ip/terminateInstanceInfo-${instanceIp}_${instanceId}.txt`,
    };
    console.log("Get terminateInstanceInfo: ", `s3://${bucket}/jelly/instance_ip/terminateInstanceInfo-${instanceIp}_${instanceId}.txt`);

    try {
        let response = await S3.getObject(getTermInfoInput).promise();
        getObjResponsePart = JSON.parse(response.Body);
    }
    catch (error) {
        console.log("get s3 object error: ", error);
    }

    return getObjResponsePart;
}

// update terminate info
// jsonInfo: 
// {"PrivateIP":"172.29.51.24","LaunchTime":"Thu Jun 24 2021 07:41:42 GMT+0000 (Coordinated Universal Time)","TerminateTime":"Fri Jun 25 2021 06:43:21 GMT+0000 (Coordinated Universal Time)","TerminateInstanceID":"i-02fddc603a0d90870"}
async function UpdateTerminateInfo(jsonInfo, bucket) {
    // update termination time
    let response;
    let oldTermTime = jsonInfo.TerminateTime;
    let oldDateObj = new Date(oldTermTime);
    console.log("old terminate date:", oldDateObj);
    let newDateObj = new Date();
    newDateObj.setHours(newDateObj.getHours() + 8 + hookDuration);
    console.log("new terminate date:", newDateObj);

    jsonInfo.TerminateTime = newDateObj.toString();
    let updatedJsonInfoStr = JSON.stringify(jsonInfo);

    let putUpdatedInfoInput = {
        Body: updatedJsonInfoStr,
        Bucket: bucket,
        Key: `jelly/instance_ip/terminateInstanceInfo-${jsonInfo.PrivateIP}_${jsonInfo.TerminateInstanceID}.txt`
    };

    try {
        response = await S3.putObject(putUpdatedInfoInput).promise();
    }
    catch (error) {
        console.log("put updated terminate info error: ", error);
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
