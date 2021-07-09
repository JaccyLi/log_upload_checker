#!/usr/bin/env bash
#
# Date:              2021-07-05
#
# need tools:        jq, bc
#

SLEEP_SEC=900
HALF_HOUR_SEC=3600
EXIT_CODE=1

TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2> /dev/null)
MY_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
MY_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
WEB=$(echo ${MY_IP} | awk -F'.' '{printf"web_%s", $NF}')

TERMINATE_INFO_TXT="s3://bucket/instance_ip/terminateInstanceInfo-${MY_IP}_${MY_ID}.json"
TERMINATE_INFO_TXT_NAME=$(echo ${TERMINATE_INFO_TXT} | awk -F'/' '{print $NF}')

JELLY_S3_LOG="s3://bucket/jelly/rawlogs"
JELLY_SERVER_LOG="/data/log/"

ALERT_LOG="/tmp/record_lifecycle_action_heartbeat.log"

BYTES_S3_LOG=
BYTES_LOCAL_LOG=

UP_TIME_SEC=$(cat /proc/uptime  | awk -F'.' '{printf"%s", $1}')
NOW_TIME_SEC=$(date +%s)
UP_TIME=$(( $NOW_TIME_SEC - $UP_TIME_SEC ))
UP_TIME_YEAR=$(date --date=@${UP_TIME} '+%Y')
UP_TIME_MONTH=$(date --date=@${UP_TIME} '+%m')
UP_TIME_DAY=$(date --date=@${UP_TIME} '+%d')
UP_TIME_HOUR=$(date --date=@${UP_TIME} '+%H')
echo "[$(date)]INFO: system uptime: $UP_TIME_YEAR-$UP_TIME_MONTH-${UP_TIME_DAY}T$UP_TIME_HOUR" >> ${ALERT_LOG}

ALERT_TAG_KEY="Alert"
TERM_FLAG=
MY_ASG_NAME=
ASG_NAMES=$(aws autoscaling describe-auto-scaling-groups --query "AutoScalingGroups[*].AutoScalingGroupName" | awk -F'"' '/[a-z]/{print $(NF-1)}')

export MY_ASG_NAME
export ASG_NAMES
export TERM_FLAG
export BYTES_S3_LOG
export BYTES_LOCAL_LOG

## install tools
installTools() {
  rpm -ql jq &> /dev/null && rpm -ql bc &> /dev/null || yum install -y jq bc
}

## if I'm in Terminating LifecycleState, then set TERM_FLAG
isTerminate() {
  if [[ -z ${ASG_NAMES} ]]
  then
    echo "[$(date)]ERROR: ASG_NAMES is empty" >> ${ALERT_LOG}
    exit $EXIT_CODE
  fi
  for name in $ASG_NAMES
  do
    termInstances=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $name --query "AutoScalingGroups[*].Instances[*]" --output text | awk '/Terminating/{print $3}')
    for instance in $termInstances
      do
        if [[ "$instance" == "$MY_ID" ]]
        then
          echo "[$(date)]INFO: I'm now in Terminating:* status." >> ${ALERT_LOG}
          TERM_FLAG=1
          MY_ASG_NAME=$name
        fi
    done
  done
}

## if TERM_FLAG is not empty, then fetch my launch and terminate time info from s3
getS3TermInstanceInfo() {
  if [[ -n $TERM_FLAG ]]
  then
    # get terminating info
    aws s3 cp $TERMINATE_INFO_TXT /tmp/
  else
    echo "[$(date)]INFO: I'm healthy." >> ${ALERT_LOG}
  fi
}

## calculate s3 log bytes
sumS3LogSize() {
  # "Tue Jun 23 2021 15:14:33"
  declare -a logBytesHoursSumStr
  declare -a logBytesDaysSumStr
  logBytesHours=
  logBytesDays=
  minuteSec=60
  hourSec=3600
  daySec=86400
  LaunchTime=$(cat /tmp/${TERMINATE_INFO_TXT_NAME} | jq .LaunchTime | awk -F' |"' '{print $2,$3,$4,$5,$6}')
  ltSec=$(date --date="${LaunchTime}" '+%s')
  #echo "launchTime: $LaunchTime, ltSec: ${ltSec}"
  TerminateTime=$(cat /tmp/${TERMINATE_INFO_TXT_NAME} | jq .TerminateTime | awk -F' |"' '{print $2,$3,$4,$5,$6}')
  ttSec=$(date --date="${TerminateTime}" '+%s')
  #echo "TerminateTime: $TerminateTime, ttSec: ${ttSec}"

  # ltSec < ttSec
  #echo "days diff: "
  #echo "scale=4;($ttSec - $ltSec)/$daySec" | bc | awk '{printf("%d\n",$1 + 2)}'
  # calculate diff days between ltSec and ttSec
  days=$(echo "scale=4;($ttSec - $ltSec)/$daySec" | bc | awk '{printf("%d\n",$1 + 2)}')
  n=0
  for ((i=0;i<${days};i++))
  do
    dateArray[$i]=$(( $ltSec + $(( i * daySec )) ))
    #echo dt=$(date --date=@${dateArray[$i]} '+%Y')-$(date --date=@${dateArray[$i]} '+%m')-$(date --date=@${dateArray[$i]} '+%d')
    # first day is not start from hour 00
    m=0
    if [[ $i -eq 0 ]] && [[ "$(date --date=@${dateArray[$i]} '+%Y')-$(date --date=@${dateArray[$i]} '+%m')-$(date --date=@${dateArray[$i]} '+%d')" == "${UP_TIME_YEAR}-${UP_TIME_MONTH}-${UP_TIME_DAY}" ]]
    then
      for h in $(seq -w $UP_TIME_HOUR 23)
      do
        logsPerHourSumStr[$m]=$(aws s3 ls ${JELLY_S3_LOG}/web=${WEB}/dt=$(date --date=@${dateArray[$i]} '+%Y')-$(date --date=@${dateArray[$i]} '+%m')-$(date --date=@${dateArray[$i]} '+%d')/$h/ | awk '{if($3 == "0") next; else print $0}' | awk '{print $3}' | tr '\n' '+' | awk '{printf"%s0",$0}')
        #echo "logsPerHourSumStr=${logsPerHourSumStr[@]}"
        let "m += 1"
      done
    else
      # list subsequent days recursively
      logsPerDaySumStr[$n]=$(aws s3 ls --recursive ${JELLY_S3_LOG}/web=${WEB}/dt=$(date --date=@${dateArray[$i]} '+%Y')-$(date --date=@${dateArray[$i]} '+%m')-$(date --date=@${dateArray[$i]} '+%d')/ | awk '{if($3 == "0") next; else print $0}' | awk '{print $3}' | tr '\n' '+' | awk '{printf"%s0",$0}')
      #echo "logsPerDaySumStr=${logsPerDaySumStr[@]}"
      let "n += 1"
    fi
  done

  #echo "h: $(echo ${logsPerHourSumStr[@]} | tr ' ' '+')"
  #echo "d: $(echo ${logsPerDaySumStr[@]} | tr ' ' '+')"

  if [[ -n ${logsPerHourSumStr[@]} ]] && [[ -n ${logsPerDaySumStr[@]} ]]
  then
    BYTES_S3_LOG=$(echo "$(echo ${logsPerHourSumStr[@]} | tr ' ' '+')+$(echo ${logsPerDaySumStr[@]} | tr ' ' '+')" | bc)
  elif [[ -z ${logsPerHourSumStr[@]} ]] && [[ -n ${logsPerDaySumStr[@]} ]]
  then
    BYTES_S3_LOG=$(echo "$(echo ${logsPerDaySumStr[@]} | tr ' ' '+')" | bc)
  elif [[ -n ${logsPerHourSumStr[@]} ]] && [[ -z ${logsPerDaySumStr[@]} ]]
  then
    BYTES_S3_LOG=$(echo "$(echo ${logsPerHourSumStr[@]} | tr ' ' '+')" | bc)
  else
    BYTES_S3_LOG=0
  fi
  echo "BYTES_S3_LOG=${BYTES_S3_LOG}" >> ${ALERT_LOG}
}

## calculate local log bytes
sumLocalLogSize() {
  sumStr=$(ls -l ${JELLY_SERVER_LOG} | grep -v 'sys_' | awk '/^-/{if($5 == "0") next; else print $5}' | tr '\n' '+' | awk '{printf"%s0",$0}')
  if [[ -n $sumStr ]]
  then
    BYTES_LOCAL_LOG=$(echo $sumStr | bc)
  else
    BYTES_LOCAL_LOG=0
  fi
  echo "BYTES_LOCAL_LOG=${BYTES_LOCAL_LOG}" >> ${ALERT_LOG}
}

## check if s3 log bytes equals to local
ifS3LogEqualLocalAndAlert() {
  TerminateTime=$(cat /tmp/${TERMINATE_INFO_TXT_NAME} | jq .TerminateTime | awk -F' |"' '{print $2,$3,$4,$5,$6}')
  termTimeInSecond=$(date --date="${TerminateTime}" '+%s')
  nowTimeSec=$(date +%s)
  if [[ $((termTimeInSecond - nowTimeSec)) -le $HALF_HOUR_SEC ]]
  then
    # check if logs size equal, and create tag
    if [[ "${BYTES_S3_LOG}" == "${BYTES_LOCAL_LOG}" ]]
    then
      echo "[$(date)]INFO: logs upload to s3 completed. do create Alert tag with value 0." >> ${ALERT_LOG}
      # check if ${ALERT_TAG_KEY} tag is exists, if exits, overwrite it with a value 0
      aws ec2 create-tags \
              --resources ${MY_ID} \
              --tags Key=${ALERT_TAG_KEY},Value=0
    else
      # if log not complete upload, tag with a value 1
      echo "[$(date)]ERROR: logs upload not complete. do create Alert tag with value 1." >> ${ALERT_LOG}
      aws ec2 create-tags \
              --resources ${MY_ID} --tags Key=${ALERT_TAG_KEY},Value=1
    fi
  else
    # time is not up
    echo "[$(date)]INFO: time is not up, terminateTime-->[${TerminateTime}]" >> ${ALERT_LOG}
    # check if logs size equal, and create tag
    if [[ "${BYTES_S3_LOG}" == "${BYTES_LOCAL_LOG}" ]]
    then
      echo "[$(date)]INFO: time is not up, but logs upload to s3 completed. do create Alert tag with value 0." >> ${ALERT_LOG}
      # check if ${ALERT_TAG_KEY} tag is exists, if exits, overwrite it with a value 0
      aws ec2 create-tags \
              --resources ${MY_ID} \
              --tags Key=${ALERT_TAG_KEY},Value=0
    fi
  fi
}

main() {
  while :
  do
    installTools

    # terminating --> set TERM_FLAG
    isTerminate

    # if TERM_FLAG is set, fetch info
    getS3TermInstanceInfo

    # if get info file, then do compare and alert
    if [[ -f /tmp/${TERMINATE_INFO_TXT_NAME} ]] || [[ ${TERM_FLAG} -eq 1 ]]
    then
      sumS3LogSize
      sumLocalLogSize
      ifS3LogEqualLocalAndAlert
    fi

    echo "[$(date)]INFO: sleeping ${SLEEP_SEC} seconds..." >> ${ALERT_LOG}
    sleep $SLEEP_SEC
  done
}

main

unset MY_ASG_NAME
unset ASG_NAMES
unset TERM_FLAG
unset BYTES_S3_LOG
unset BYTES_LOCAL_LOG
