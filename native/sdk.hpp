#pragma once
#include "adapter.grpc.pb.h"
#include <grpcpp/grpcpp.h>
#include <stdexcept>
#include <chrono>
namespace sdv_sdk {
class Transport {
  std::unique_ptr<sdv::Adapter::Stub> stub;
public:
  explicit Transport(const std::string& endpoint="127.0.0.1:50051"):
    stub(sdv::Adapter::NewStub(grpc::CreateChannel(endpoint,grpc::InsecureChannelCredentials()))){}
  sdv::SnapshotReply snapshot(){grpc::ClientContext ctx;ctx.set_deadline(std::chrono::system_clock::now()+std::chrono::seconds(2));sdv::Empty request;sdv::SnapshotReply response;auto status=stub->Snapshot(&ctx,request,&response);if(!status.ok())throw std::runtime_error(status.error_message());return response;}
  void send_can(uint32_t id,const std::string& data){grpc::ClientContext ctx;ctx.set_deadline(std::chrono::system_clock::now()+std::chrono::seconds(2));sdv::Frame frame;sdv::Empty response;frame.set_id(id);frame.set_data(data);auto status=stub->SendCan(&ctx,frame,&response);if(!status.ok())throw std::runtime_error(status.error_message());}
  void publish_intent(const std::string& json){grpc::ClientContext ctx;ctx.set_deadline(std::chrono::system_clock::now()+std::chrono::seconds(2));sdv::Intent intent;sdv::Empty response;intent.set_data(json);auto status=stub->PublishIntent(&ctx,intent,&response);if(!status.ok())throw std::runtime_error(status.error_message());}
};
}
