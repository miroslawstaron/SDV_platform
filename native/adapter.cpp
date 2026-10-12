// SIL Kit lifecycle/CAN patterns adapted from Vector's MIT-licensed demos.
// SOME/IP subscription patterns adapted from COVESA's MPL-2.0 examples.
#include <silkit/SilKit.hpp>
#include <silkit/services/can/all.hpp>
#include <silkit/services/orchestration/all.hpp>
#include <vsomeip/vsomeip.hpp>
#include <grpcpp/grpcpp.h>
#include "adapter.grpc.pb.h"
#include <chrono>
#include <deque>
#include <map>
#include <mutex>
#include <thread>
#include <iostream>
#include <atomic>
using Clock = std::chrono::steady_clock;
using namespace SilKit::Services::Can;
static uint64_t ns() { return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count(); }
class Bridge final : public sdv::Adapter::Service {
    std::mutex mu;
    std::map<uint32_t,std::pair<std::string,uint64_t>> frames;
    std::deque<sdv::Event> events;
    std::string intent;
    uint64_t intent_time=0, request_time=0;
    bool overflow=false;
    std::atomic<bool> available{false},offering{true};
    std::string role;
    std::unique_ptr<SilKit::IParticipant> participant;
    ICanController* can;
    std::shared_ptr<vsomeip::application> ip;
    std::thread ip_thread;
    const vsomeip::service_t service=0x1234;
    const vsomeip::instance_t instance=0x0001;
    void log(const std::string& protocol,const std::string& kind,uint32_t id,const std::string& data={}) {
        std::lock_guard<std::mutex> lock(mu);
        if(events.size()>=20000) { overflow=true; return; }
        sdv::Event e; e.set_protocol(protocol); e.set_kind(kind); e.set_id(id); e.set_data(data); e.set_elapsed_ns(ns()); events.push_back(e);
    }
public:
    Bridge(std::string r):role(std::move(r)) {
        auto config=SilKit::Config::ParticipantConfigurationFromString("{\"Logging\":{\"Sinks\":[{\"Type\":\"Stdout\",\"Level\":\"Warn\"}]}}");
        participant=SilKit::CreateParticipant(config,role,std::getenv("REGISTRY_URI")?std::getenv("REGISTRY_URI"):"silkit://registry:8500");
        auto life=participant->CreateLifecycleService({SilKit::Services::Orchestration::OperationMode::Autonomous});
        can=participant->CreateCanController("can0","vehicle-can");
        can->AddFrameHandler([this](ICanController*,const CanFrameEvent& e) {
            std::string bytes(reinterpret_cast<const char*>(e.frame.dataField.data()),e.frame.dataField.size());
            { std::lock_guard<std::mutex> lock(mu); frames[e.frame.canId]={bytes,ns()}; }
            log("CAN","rx",e.frame.canId,bytes);
        },static_cast<SilKit::Services::DirectionMask>(SilKit::Services::TransmitDirection::RX));
        life->SetCommunicationReadyHandler([this](){can->SetBaudRate(500000,2000000,0);can->Start();});
        life->StartLifecycle();
        if(role=="navigation" || role=="controller") {
            ip=vsomeip::runtime::get()->create_application(role);
            if(!ip->init()) throw std::runtime_error("vSomeIP initialization failed");
            ip->register_state_handler([this](vsomeip::state_type_e state){
                if(state!=vsomeip::state_type_e::ST_REGISTERED) return;
                if(role=="navigation") {
                    std::set<vsomeip::eventgroup_t> groups{1};
                    ip->offer_event(service,instance,0x8001,groups,vsomeip::event_type_e::ET_FIELD);
                    ip->offer_service(service,instance,1,0);
                    log("SOME/IP","offer",service);
                } else {
                    ip->request_service(service,instance,1,0);
                    ip->request_event(service,instance,0x8001,{1},vsomeip::event_type_e::ET_FIELD);
                    ip->subscribe(service,instance,1,1);
                    log("SOME/IP","find",service);
                }
            });
            ip->register_availability_handler(service,instance,[this](auto,auto,bool a){
                { std::lock_guard<std::mutex> lock(mu);available=a; }
                log("SOME/IP",a?"available":"unavailable",service);
            },1,0);
            ip->register_message_handler(service,instance,vsomeip::ANY_METHOD,[this](const std::shared_ptr<vsomeip::message>& msg){
                if(role=="navigation" && msg->get_method()==1 && msg->get_message_type()==vsomeip::message_type_e::MT_REQUEST) {
                    log("SOME/IP","request_rx",1);
                    auto response=vsomeip::runtime::get()->create_response(msg);
                    auto payload=vsomeip::runtime::get()->create_payload();
                    std::string value; {std::lock_guard<std::mutex> lock(mu);value=intent;}
                    payload->set_data(reinterpret_cast<const vsomeip::byte_t*>(value.data()),value.size());
                    response->set_payload(payload);ip->send(response);log("SOME/IP","response_tx",1,value);
                } else if(role=="controller") {
                    auto p=msg->get_payload();std::string value(reinterpret_cast<const char*>(p->get_data()),p->get_length());
                    {std::lock_guard<std::mutex> lock(mu);intent=value;intent_time=ns();}
                    log("SOME/IP",msg->get_method()==1?"response_rx":"event_rx",msg->get_method(),value);
                }
            });
            ip_thread=std::thread([this](){ip->start();});
        }
    }
    grpc::Status SendCan(grpc::ServerContext*,const sdv::Frame* f,sdv::Empty*) override {
        if(f->data().size()>64) return {grpc::StatusCode::INVALID_ARGUMENT,"CAN FD payload exceeds 64 bytes"};
        CanFrame frame{}; frame.canId=f->id();frame.flags=static_cast<CanFrameFlagMask>(CanFrameFlag::Fdf)|static_cast<CanFrameFlagMask>(CanFrameFlag::Brs);
        frame.dlc=f->data().size()<=8?f->data().size():f->data().size()==16?10:f->data().size()==32?13:15;
        frame.dataField=SilKit::Util::Span<const uint8_t>(reinterpret_cast<const uint8_t*>(f->data().data()),f->data().size());
        can->SendFrame(frame);log("CAN","tx",f->id(),f->data()); return grpc::Status::OK;
    }
    grpc::Status PublishIntent(grpc::ServerContext*,const sdv::Intent* value,sdv::Empty*) override {
        if(role!="navigation") return {grpc::StatusCode::FAILED_PRECONDITION,"Only navigation offers intent"};
        {std::lock_guard<std::mutex> lock(mu);intent=value->data();intent_time=ns();}
        if(offering) {auto p=vsomeip::runtime::get()->create_payload();p->set_data(reinterpret_cast<const vsomeip::byte_t*>(value->data().data()),value->data().size());ip->notify(service,instance,0x8001,p,true);log("SOME/IP","event_tx",0x8001,value->data());}
        return grpc::Status::OK;
    }
    grpc::Status Snapshot(grpc::ServerContext*,const sdv::Empty*,sdv::SnapshotReply* reply) override {
        {std::lock_guard<std::mutex> lock(mu);for(auto& [id,value]:frames){auto f=reply->add_frames();f->set_id(id);f->set_data(value.first);f->set_age_ns(ns()-value.second);}reply->mutable_intent()->set_data(intent);reply->mutable_intent()->set_age_ns(intent_time?ns()-intent_time:UINT64_MAX);reply->set_available(available);}
        if(role=="controller" && available && ns()-request_time>1000000000) {
            request_time=ns();auto req=vsomeip::runtime::get()->create_request();req->set_service(service);req->set_instance(instance);req->set_method(1);req->set_interface_version(1);req->set_reliable(false);ip->send(req);log("SOME/IP","request_tx",1);
        }
        return grpc::Status::OK;
    }
    grpc::Status Drain(grpc::ServerContext*,const sdv::Empty*,sdv::Events* reply) override {
        std::lock_guard<std::mutex> lock(mu);for(auto& e:events)*reply->add_events()=e;events.clear();reply->set_overflow(overflow);return grpc::Status::OK;
    }
    grpc::Status Offer(grpc::ServerContext*,const sdv::OfferRequest* req,sdv::Empty*) override {
        if(role!="navigation") return {grpc::StatusCode::FAILED_PRECONDITION,"Only navigation offers services"};
        offering=req->enabled();if(offering)ip->offer_service(service,instance,1,0);else ip->stop_offer_service(service,instance,1,0);
        log("SOME/IP",offering?"offer":"withdraw",service);return grpc::Status::OK;
    }
    grpc::Status Reset(grpc::ServerContext*,const sdv::Empty*,sdv::Empty*) override {
        std::lock_guard<std::mutex> lock(mu);frames.clear();intent.clear();intent_time=0;events.clear();overflow=false;return grpc::Status::OK;
    }
};
int main(int argc,char** argv) {
    try {Bridge bridge(argc>1?argv[1]:"sensor");grpc::ServerBuilder builder;builder.AddListeningPort("127.0.0.1:50051",grpc::InsecureServerCredentials());builder.RegisterService(&bridge);auto server=builder.BuildAndStart();std::cout<<"SDV transport ready"<<std::endl;server->Wait();}
    catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
