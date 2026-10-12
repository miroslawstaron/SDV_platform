// A dependency-free replacement ECU process using Boost.PropertyTree JSON.
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cmath>
int main(){std::string line;while(std::getline(std::cin,line)){
  try{boost::property_tree::ptree p;std::istringstream in(line);boost::property_tree::read_json(in,p);
  double speed=p.get<double>("network.frames.256.signals.Speed",0),age=p.get<double>("network.frames.256.age",999);
  double decel=p.get<double>("vehicle.normal_decel",3),target=0,acc=0,brake=decel;
  if(age<=.2 && p.get<bool>("network.available",false) && p.get<double>("network.intent_age",999)<=.2){
    double distance=std::max(0.,p.get<double>("network.frames.256.signals.Remaining",0)-2);
    if(p.get<int>("network.frames.256.signals.RedLight",0)) distance=std::min(distance,std::max(0.,p.get<double>("network.frames.256.signals.LightDistance",0)-3));
    target=std::min({p.get<double>("network.intent.target_speed",0),p.get<double>("network.frames.256.signals.SpeedLimit",0),std::sqrt(decel*distance)});
    acc=std::min(1.,std::max(0.,1.5*(target-speed)));brake=std::min(decel,std::max(0.,1.5*(speed-target)));
  }
  if(target<=.01){acc=0;brake=decel;}
  std::cout<<"{\"can\":[[512,{\"Acceleration\":"<<acc<<",\"Deceleration\":"<<brake<<",\"LaneRequest\":0,\"TargetSpeed\":"<<target<<",\"Sequence\":"<<p.get<int>("sequence",0)%65536<<"}]]}"<<std::endl;
  }catch(const std::exception& e){std::cout<<"{\"error\":\"Invalid controller input\"}"<<std::endl;}
}}
